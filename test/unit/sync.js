import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it, mock } from "node:test";

import { testDatabase } from "../../helpers/database.js";

import { clearMemoryCache } from "../../lib/hcard.js";
import { blockDomain } from "../../lib/storage/blocklist.js";
import { getSyncState, runSync, stopSync } from "../../lib/sync.js";

const { client, database, mongoServer } = await testDatabase();

const options = { token: "token", domain: "website.example" };

/**
 * A JF2 entry as webmention.io returns it.
 * @param {number} id - Webmention id
 * @param {string} [author] - Author domain
 * @returns {object} JF2 entry
 */
const mention = (id, author = "alice.example") => ({
  "wm-id": id,
  "wm-received": "2026-08-01T10:00:00.000Z",
  "wm-property": "in-reply-to",
  "wm-target": "https://website.example/notes/one/",
  author: {
    name: "Alice",
    url: `https://${author}/`,
    photo: `https://${author}/p.jpg`,
  },
  url: `https://${author}/reply/${id}`,
  content: { text: "Nice post" },
});

/**
 * Stub `fetch`, routing webmention.io requests to the given pages and any
 * other request (h-card discovery) to an empty page.
 * @param {Array<Array>} pages - Successive pages of entries
 * @returns {Function} The mock, for call assertions
 */
const stubFetch = (pages) => {
  let call = 0;
  const fetchMock = mock.fn(async (url) => {
    if (!String(url).includes("webmention.io")) {
      return {
        ok: true,
        headers: { get: () => "text/html" },
        text: async () => "",
      };
    }

    const children = pages[call] ?? [];
    call++;
    return { ok: true, json: async () => ({ children }) };
  });
  globalThis.fetch = fetchMock;
  return fetchMock;
};

describe("endpoint-webmention-io/lib/sync", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    clearMemoryCache();
    await database.collection("webmentions").deleteMany({});
    await database.collection("webmentionBlocklist").deleteMany({});
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
  });

  after(async () => {
    stopSync();
    globalThis.fetch = originalFetch;
    await client.close();
    await mongoServer.stop();
  });

  it("Reports an error without a database", async () => {
    const result = await runSync({}, options);

    assert.equal(result.error, "No database available");
    assert.equal(getSyncState().lastError, "No database available");
  });

  it("Accepts an Indiekit instance or a database", async () => {
    stubFetch([[mention(1)]]);

    const result = await runSync({ database }, options);

    assert.equal(result.mentionsAdded, 1);
  });

  it("Stores the mentions it fetches", async () => {
    stubFetch([[mention(1), mention(2)]]);

    const result = await runSync(database, options);

    assert.equal(result.mentionsAdded, 2);
    assert.equal(await database.collection("webmentions").countDocuments(), 2);
  });

  it("Counts a mention already stored as not added", async () => {
    stubFetch([[mention(1)]]);
    await runSync(database, options);
    stubFetch([[mention(1)]]);

    const result = await runSync(database, options);

    assert.equal(result.mentionsAdded, 0);
    assert.equal(await database.collection("webmentions").countDocuments(), 1);
  });

  // A blocked domain is dropped before it is ever written, so blocking takes
  // effect for mentions that have not arrived yet as well as those that have.
  it("Skips mentions from a blocked domain", async () => {
    await blockDomain(
      database.collection("webmentionBlocklist"),
      "spam.example",
    );
    stubFetch([[mention(1, "alice.example"), mention(2, "spam.example")]]);

    const result = await runSync(database, options);

    assert.equal(result.mentionsAdded, 1);
    assert.equal(result.mentionsFiltered, 1);
    assert.equal(await database.collection("webmentions").countDocuments(), 1);
  });

  it("Asks only for mentions newer than the highest already stored", async () => {
    stubFetch([[mention(5)]]);
    await runSync(database, options);

    const fetchMock = stubFetch([[]]);
    await runSync(database, options);

    const url = String(fetchMock.mock.calls[0].arguments[0]);
    assert.match(url, /since_id=5/);
  });

  it("Sends no since_id on the first sync", async () => {
    const fetchMock = stubFetch([[]]);

    await runSync(database, options);

    const url = String(fetchMock.mock.calls[0].arguments[0]);
    assert.equal(url.includes("since_id"), false);
  });

  it("Stops when a page comes back empty", async () => {
    const fetchMock = stubFetch([[]]);

    await runSync(database, options);

    assert.equal(
      fetchMock.mock.callCount(),
      1,
      "does not ask for a second page",
    );
  });

  it("Recovers from a failing request", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("ETIMEDOUT");
    });

    const result = await runSync(database, options);

    assert.equal(result.error, "ETIMEDOUT");
    assert.equal(getSyncState().syncing, false, "does not stay locked");
  });

  it("Reports the error webmention.io returned", async () => {
    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 401 }));

    const result = await runSync(database, options);

    assert.equal(result.error, "webmention.io returned 401");
  });

  it("Records the time of a completed sync", async () => {
    stubFetch([[mention(1)]]);

    await runSync(database, options);

    assert.ok(Date.parse(getSyncState().lastSync));
    assert.equal(getSyncState().lastError, null);
  });

  it("Returns a copy of the state, not the state itself", () => {
    const state = getSyncState();
    state.syncing = "tampered";

    assert.notEqual(getSyncState().syncing, "tampered");
  });
});
