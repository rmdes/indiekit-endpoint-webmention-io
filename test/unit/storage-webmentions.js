import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it } from "node:test";

import { testDatabase } from "../../helpers/database.js";

import {
  deleteAll,
  deleteByDomain,
  documentToJf2,
  ensureIndexes,
  getDomainsWithMissingPhotos,
  getMaxWmId,
  getWebmentionCounts,
  getWebmentions,
  hideByDomain,
  hideWebmention,
  jf2ToDocument,
  unhideByDomain,
  unhideWebmention,
  updateAuthorDataByDomain,
  upsertWebmention,
} from "../../lib/storage/webmentions.js";

const { client, database, mongoServer } = await testDatabase();
const collection = database.collection("webmentions");

/**
 * A JF2 entry shaped like those returned by webmention.io.
 * @param {object} [overrides] - Properties to override
 * @returns {object} JF2 entry
 */
const mention = (overrides = {}) => ({
  "wm-id": 1,
  "wm-received": "2026-08-01T10:00:00.000Z",
  "wm-property": "in-reply-to",
  "wm-target": "https://website.example/notes/one/",
  author: {
    name: "Alice",
    url: "https://alice.example/",
    photo: "https://alice.example/photo.jpg",
  },
  url: "https://alice.example/notes/reply",
  published: "2026-08-01T09:00:00.000Z",
  content: { text: "Nice post" },
  ...overrides,
});

describe("endpoint-webmention-io/lib/storage/webmentions", () => {
  beforeEach(async () => {
    await collection.deleteMany({});
    await ensureIndexes(collection);
  });

  after(async () => {
    await client.close();
    await mongoServer.stop();
  });

  describe("jf2ToDocument", () => {
    it("Maps a webmention.io entry to a document", () => {
      const doc = jf2ToDocument(mention());

      assert.equal(doc.wmId, 1);
      assert.equal(doc.wmProperty, "in-reply-to");
      assert.equal(doc.authorName, "Alice");
      assert.equal(doc.sourceUrl, "https://alice.example/notes/reply");
      assert.equal(doc.sourceDomain, "alice.example");
      assert.equal(doc.hidden, false);
    });

    it("Wraps plain text content in a paragraph", () => {
      const doc = jf2ToDocument(mention({ content: { text: "Hello" } }));

      assert.equal(doc.contentHtml, "<p>Hello</p>");
      assert.equal(doc.contentText, "Hello");
    });

    it("Prefers HTML content, sanitised", () => {
      const doc = jf2ToDocument(
        mention({ content: { html: "<p>Hi</p><script>x()</script>" } }),
      );

      assert.match(doc.contentHtml, /<p>Hi<\/p>/);
      assert.equal(doc.contentHtml.includes("<script>"), false);
    });

    it("Falls back to the source URL for the domain", () => {
      const doc = jf2ToDocument(mention({ author: {} }));

      assert.equal(doc.authorName, null);
      assert.equal(doc.sourceDomain, "alice.example");
    });

    it("Defaults the received date when absent", () => {
      const doc = jf2ToDocument(mention({ "wm-received": undefined }));

      assert.ok(Date.parse(doc.wmReceived));
    });
  });

  describe("documentToJf2", () => {
    it("Returns an entry the public API can serve", () => {
      const jf2 = documentToJf2(jf2ToDocument(mention()));

      assert.equal(jf2.type, "entry");
      assert.equal(jf2["wm-id"], 1);
      assert.equal(jf2.author.name, "Alice");
      assert.equal(jf2.content.text, "Nice post");
    });

    it("Uses empty strings rather than null for absent author fields", () => {
      const jf2 = documentToJf2(jf2ToDocument(mention({ author: {} })));

      assert.equal(jf2.author.name, "");
      assert.equal(jf2.author.url, "");
      assert.equal(jf2.author.photo, "");
    });

    it("Omits name and content when the document has neither", () => {
      const jf2 = documentToJf2(
        jf2ToDocument(mention({ content: undefined, name: undefined })),
      );

      assert.equal("name" in jf2, false);
      assert.equal("content" in jf2, false);
    });

    it("Falls back to the received date when unpublished", () => {
      const jf2 = documentToJf2(jf2ToDocument(mention({ published: undefined })));

      assert.equal(jf2.published, "2026-08-01T10:00:00.000Z");
    });
  });

  describe("upsertWebmention", () => {
    it("Reports a webmention as newly inserted", async () => {
      assert.equal(await upsertWebmention(collection, mention()), true);
      assert.equal(await collection.countDocuments(), 1);
    });

    it("Does not duplicate a webmention already stored", async () => {
      await upsertWebmention(collection, mention());

      assert.equal(await upsertWebmention(collection, mention()), false);
      assert.equal(await collection.countDocuments(), 1);
    });

    // `$setOnInsert` means a re-sync leaves stored entries alone. That is what
    // keeps a moderation decision from being undone the next time the mention
    // comes back from webmention.io.
    it("Leaves a hidden webmention hidden when synced again", async () => {
      await upsertWebmention(collection, mention());
      await hideWebmention(collection, 1, "manual");

      await upsertWebmention(collection, mention());
      const doc = await collection.findOne({ wmId: 1 });

      assert.equal(doc.hidden, true);
      assert.equal(doc.hiddenReason, "manual");
    });
  });

  describe("getWebmentions", () => {
    beforeEach(async () => {
      await upsertWebmention(collection, mention({ "wm-id": 1 }));
      await upsertWebmention(
        collection,
        mention({
          "wm-id": 2,
          "wm-received": "2026-08-02T10:00:00.000Z",
          "wm-property": "like-of",
          "wm-target": "https://website.example/notes/two/",
        }),
      );
    });

    it("Returns visible webmentions, most recent first", async () => {
      const { items, total } = await getWebmentions(collection);

      assert.equal(total, 2);
      assert.deepEqual(
        items.map((i) => i.wmId),
        [2, 1],
      );
    });

    it("Excludes hidden webmentions by default", async () => {
      await hideWebmention(collection, 1);
      const { items, total } = await getWebmentions(collection);

      assert.equal(total, 1);
      assert.deepEqual(
        items.map((i) => i.wmId),
        [2],
      );
    });

    it("Includes hidden webmentions when asked", async () => {
      await hideWebmention(collection, 1);
      const { total } = await getWebmentions(collection, { showHidden: true });

      assert.equal(total, 2);
    });

    it("Matches a target with or without its trailing slash", async () => {
      const withSlash = await getWebmentions(collection, {
        target: "https://website.example/notes/one/",
      });
      const without = await getWebmentions(collection, {
        target: "https://website.example/notes/one",
      });

      assert.equal(withSlash.total, 1);
      assert.equal(without.total, 1);
    });

    it("Filters by webmention property", async () => {
      const { items } = await getWebmentions(collection, {
        wmProperty: "like-of",
      });

      assert.deepEqual(
        items.map((i) => i.wmId),
        [2],
      );
    });

    it("Paginates", async () => {
      const first = await getWebmentions(collection, { page: 0, perPage: 1 });
      const second = await getWebmentions(collection, { page: 1, perPage: 1 });

      assert.deepEqual(first.items.map((i) => i.wmId), [2]);
      assert.deepEqual(second.items.map((i) => i.wmId), [1]);
      assert.equal(first.total, 2, "total counts every match, not the page");
    });
  });

  describe("counts and sync bookkeeping", () => {
    it("Counts total, hidden and visible", async () => {
      await upsertWebmention(collection, mention({ "wm-id": 1 }));
      await upsertWebmention(collection, mention({ "wm-id": 2 }));
      await hideWebmention(collection, 1);

      assert.deepEqual(await getWebmentionCounts(collection), {
        total: 2,
        hidden: 1,
        visible: 1,
      });
    });

    it("Gets the highest stored wm-id", async () => {
      await upsertWebmention(collection, mention({ "wm-id": 7 }));
      await upsertWebmention(collection, mention({ "wm-id": 3 }));

      assert.equal(await getMaxWmId(collection), 7);
    });

    it("Reports zero when nothing is stored", async () => {
      assert.equal(await getMaxWmId(collection), 0);
    });
  });

  describe("moderation", () => {
    beforeEach(async () => {
      await upsertWebmention(collection, mention({ "wm-id": 1 }));
      await upsertWebmention(
        collection,
        mention({
          "wm-id": 2,
          author: { name: "Mallory", url: "https://spam.example/" },
          url: "https://spam.example/post",
        }),
      );
    });

    it("Hides and unhides a single webmention", async () => {
      await hideWebmention(collection, 1, "privacy");
      let doc = await collection.findOne({ wmId: 1 });
      assert.equal(doc.hidden, true);
      assert.equal(doc.hiddenReason, "privacy");
      assert.ok(doc.hiddenAt);

      await unhideWebmention(collection, 1);
      doc = await collection.findOne({ wmId: 1 });
      assert.equal(doc.hidden, false);
      assert.equal(doc.hiddenReason, null);
      assert.equal(doc.hiddenAt, null);
    });

    it("Hides every webmention from a domain, counting only those it changed", async () => {
      assert.equal(await hideByDomain(collection, "spam.example"), 1);
      assert.equal(
        await hideByDomain(collection, "spam.example"),
        0,
        "already hidden mentions are not counted again",
      );
    });

    // Unblocking a domain should not resurrect something hidden by hand. Both
    // mentions here are from the blocked domain, so only `hiddenReason` can
    // tell them apart.
    it("Unhides only what the blocklist hid", async () => {
      await upsertWebmention(
        collection,
        mention({
          "wm-id": 3,
          author: { name: "Mallory", url: "https://spam.example/" },
          url: "https://spam.example/other",
        }),
      );
      await hideByDomain(collection, "spam.example");
      await hideWebmention(collection, 3, "manual");

      const unhidden = await unhideByDomain(collection, "spam.example");
      const manual = await collection.findOne({ wmId: 3 });
      const blocked = await collection.findOne({ wmId: 2 });

      assert.equal(unhidden, 1, "only the blocklist-hidden mention is restored");
      assert.equal(manual.hidden, true, "a manual hide survives unblocking");
      assert.equal(blocked.hidden, false);
    });

    it("Deletes every webmention from a domain", async () => {
      assert.equal(await deleteByDomain(collection, "spam.example"), 1);
      assert.equal(await collection.countDocuments(), 1);
    });

    it("Deletes everything", async () => {
      assert.equal(await deleteAll(collection), 2);
      assert.equal(await collection.countDocuments(), 0);
    });
  });

  describe("author backfill", () => {
    it("Lists domains whose entries are missing an author photo", async () => {
      await upsertWebmention(collection, mention({ "wm-id": 1 }));
      await upsertWebmention(
        collection,
        mention({
          "wm-id": 2,
          author: { name: "Bob", url: "https://bob.example/" },
        }),
      );

      const domains = await getDomainsWithMissingPhotos(collection);

      assert.deepEqual(domains, ["bob.example"]);
    });

    it("Fills in only the entries that lack the data", async () => {
      await upsertWebmention(
        collection,
        mention({
          "wm-id": 2,
          author: { name: "Bob", url: "https://bob.example/" },
        }),
      );

      const updated = await updateAuthorDataByDomain(collection, "bob.example", {
        photoUrl: "https://bob.example/me.jpg",
      });
      const doc = await collection.findOne({ wmId: 2 });

      assert.equal(updated, 1);
      assert.equal(doc.authorPhoto, "https://bob.example/me.jpg");
    });

    it("Does nothing when given no data", async () => {
      await upsertWebmention(collection, mention());

      assert.equal(
        await updateAuthorDataByDomain(collection, "alice.example", {}),
        0,
      );
    });
  });
});
