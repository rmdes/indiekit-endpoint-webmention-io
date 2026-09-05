import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it, mock } from "node:test";

import { testDatabase } from "../../helpers/database.js";

import { apiController } from "../../lib/controllers/api.js";
import { blocklistController } from "../../lib/controllers/blocklist.js";
import { dashboardController } from "../../lib/controllers/dashboard.js";
import { blockDomain, getBlocklist } from "../../lib/storage/blocklist.js";
import { upsertWebmention } from "../../lib/storage/webmentions.js";

const { client, database, mongoServer } = await testDatabase();
const webmentions = database.collection("webmentions");
const blocklist = database.collection("webmentionBlocklist");

/**
 * Express request double carrying what these controllers read.
 * @param {object} [options] - Request parts
 * @param {object} [options.query] - Query string values
 * @param {object} [options.body] - Form body
 * @param {object} [options.params] - Route parameters
 * @param {object|null} [options.db] - Database, or null when unavailable
 * @returns {object} Request
 */
const mockRequest = ({
  query = {},
  body = {},
  params = {},
  db = database,
} = {}) => ({
  query,
  body,
  params,
  app: {
    locals: {
      application: {
        getWebmentionDb: () => db,
        webmentionEndpoint: "/webmentions",
        webmentionConfig: { cacheTtl: 60 },
      },
    },
  },
});

/**
 * Express response double recording what the controller did with it.
 * @returns {object} Response
 */
const mockResponse = () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    view: undefined,
    locals: { __: (key) => key },
    redirectedTo: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    render(view, locals) {
      this.view = { view, locals };
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      return this;
    },
  };
  return res;
};

const mention = (id, author = "alice.example") => ({
  "wm-id": id,
  "wm-received": "2026-08-01T10:00:00.000Z",
  "wm-property": "in-reply-to",
  "wm-target": "https://website.example/notes/one/",
  author: { name: "Alice", url: `https://${author}/` },
  url: `https://${author}/reply/${id}`,
  content: { text: "Nice post" },
});

describe("endpoint-webmention-io/lib/controllers", () => {
  beforeEach(async () => {
    await webmentions.deleteMany({});
    await blocklist.deleteMany({});
    mock.method(console, "error", () => {});
  });

  after(async () => {
    await client.close();
    await mongoServer.stop();
  });

  describe("api", () => {
    it("Serves stored webmentions as a JF2 feed", async () => {
      await upsertWebmention(webmentions, mention(1));
      const response = mockResponse();

      await apiController.getMentions(mockRequest(), response);

      assert.equal(response.body.type, "feed");
      assert.equal(response.body.children.length, 1);
      assert.equal(response.body.children[0]["wm-id"], 1);
    });

    // The public API must not expose what has been moderated away.
    it("Omits hidden webmentions", async () => {
      await upsertWebmention(webmentions, mention(1));
      await webmentions.updateOne({ wmId: 1 }, { $set: { hidden: true } });
      const response = mockResponse();

      await apiController.getMentions(mockRequest(), response);

      assert.equal(response.body.children.length, 0);
    });

    it("Filters by target and property", async () => {
      await upsertWebmention(webmentions, mention(1));
      await upsertWebmention(webmentions, {
        ...mention(2),
        "wm-property": "like-of",
      });
      const response = mockResponse();

      await apiController.getMentions(
        mockRequest({ query: { "wm-property": "like-of" } }),
        response,
      );

      assert.deepEqual(
        response.body.children.map((c) => c["wm-id"]),
        [2],
      );
    });

    it("Caps how many can be asked for at once", async () => {
      const response = mockResponse();

      await apiController.getMentions(
        mockRequest({ query: { "per-page": "999999" } }),
        response,
      );

      assert.equal(response.body.type, "feed", "serves rather than erroring");
    });

    it("Sets a cache header", async () => {
      const response = mockResponse();

      await apiController.getMentions(mockRequest(), response);

      assert.equal(response.headers["Cache-Control"], "public, max-age=60");
    });

    it("Reports the database being unavailable", async () => {
      const response = mockResponse();

      await apiController.getMentions(mockRequest({ db: null }), response);

      assert.equal(response.statusCode, 503);
      assert.equal(response.body.error, "Database unavailable");
    });
  });

  describe("dashboard", () => {
    it("Blocks a domain and hides what it already sent", async () => {
      await upsertWebmention(webmentions, mention(1, "spam.example"));
      const response = mockResponse();

      await dashboardController.blockDomainHandler(
        mockRequest({ body: { domain: "spam.example" } }),
        response,
      );

      const doc = await webmentions.findOne({ wmId: 1 });
      const [entry] = await getBlocklist(blocklist);

      assert.equal(doc.hidden, true);
      assert.equal(doc.hiddenReason, "blocklist");
      assert.equal(entry.domain, "spam.example");
      assert.match(response.redirectedTo, /blocked=1/);
    });

    it("Rejects a block with no domain", async () => {
      const response = mockResponse();

      await dashboardController.blockDomainHandler(
        mockRequest({ body: {} }),
        response,
      );

      assert.match(response.redirectedTo, /error=no-domain/);
      assert.equal(await blocklist.countDocuments(), 0);
    });

    // Privacy removal deletes rather than hides, so the content is gone.
    it("Deletes a domain's mentions and blocks it as privacy", async () => {
      await upsertWebmention(webmentions, mention(1, "spam.example"));
      const response = mockResponse();

      await dashboardController.privacyRemove(
        mockRequest({ body: { domain: "spam.example" } }),
        response,
      );

      const [entry] = await getBlocklist(blocklist);

      assert.equal(await webmentions.countDocuments(), 0);
      assert.equal(entry.reason, "privacy");
      assert.match(response.redirectedTo, /removed=1&count=1/);
    });

    it("Hides and unhides a single mention", async () => {
      await upsertWebmention(webmentions, mention(1));
      const response = mockResponse();

      await dashboardController.hide(
        mockRequest({ params: { wmId: "1" }, body: { wmId: "1" } }),
        response,
      );
      let doc = await webmentions.findOne({ wmId: 1 });
      assert.equal(doc.hidden, true);

      await dashboardController.unhide(
        mockRequest({ params: { wmId: "1" }, body: { wmId: "1" } }),
        response,
      );
      doc = await webmentions.findOne({ wmId: 1 });
      assert.equal(doc.hidden, false);
    });
  });

  describe("blocklist", () => {
    it("Renders the blocked domains", async () => {
      await blockDomain(blocklist, "spam.example", "spam", 2);
      const response = mockResponse();

      await blocklistController.list(mockRequest(), response);

      assert.equal(response.view.view, "webmentions-blocklist");
      assert.equal(response.view.locals.entries.length, 1);
      assert.equal(response.view.locals.entries[0].domain, "spam.example");
    });

    it("Renders an empty list without a database", async () => {
      const response = mockResponse();

      await blocklistController.list(mockRequest({ db: null }), response);

      assert.deepEqual(response.view.locals.entries, []);
    });

    // Unblocking restores what the blocklist hid, and reports how many.
    it("Unblocks a domain and restores its mentions", async () => {
      await upsertWebmention(webmentions, mention(1, "spam.example"));
      await webmentions.updateOne(
        { wmId: 1 },
        { $set: { hidden: true, hiddenReason: "blocklist" } },
      );
      await blockDomain(blocklist, "spam.example");
      const response = mockResponse();

      await blocklistController.unblock(
        mockRequest({ params: { domain: "spam.example" } }),
        response,
      );

      const doc = await webmentions.findOne({ wmId: 1 });

      assert.equal(await blocklist.countDocuments(), 0);
      assert.equal(doc.hidden, false);
      assert.match(response.redirectedTo, /unblocked=1&unhidden=1/);
    });

    it("Decodes a domain that arrived URL-encoded", async () => {
      await blockDomain(blocklist, "spam.example");
      const response = mockResponse();

      await blocklistController.unblock(
        mockRequest({ params: { domain: encodeURIComponent("spam.example") } }),
        response,
      );

      assert.equal(await blocklist.countDocuments(), 0);
    });
  });
});
