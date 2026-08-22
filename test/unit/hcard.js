import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it, mock } from "node:test";

import { testDatabase } from "../../helpers/database.js";

import {
  clearMemoryCache,
  discoverAuthorData,
  parseHcard,
} from "../../lib/hcard.js";

const { client, database, mongoServer } = await testDatabase();
const cacheCollection = database.collection("webmentionAuthorCache");

/**
 * Stub `fetch` with a single HTML response.
 * @param {object} [options] - Response options
 * @param {string} [options.body] - Response body
 * @param {boolean} [options.ok] - Whether the response succeeded
 * @param {string} [options.contentType] - Content type header
 * @returns {Function} The mock, for call assertions
 */
const stubFetch = ({ body = "", ok = true, contentType = "text/html" } = {}) => {
  const fetchMock = mock.fn(async () => ({
    ok,
    headers: { get: () => contentType },
    text: async () => body,
  }));
  globalThis.fetch = fetchMock;
  return fetchMock;
};

const HCARD = `
  <body>
    <div class="h-card">
      <img class="u-photo" src="/me.jpg" alt="">
      <a class="u-url" href="/about">Alice</a>
    </div>
  </body>
`;

describe("endpoint-webmention-io/lib/hcard", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    clearMemoryCache();
    await cacheCollection.deleteMany({});
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await client.close();
    await mongoServer.stop();
  });

  describe("parseHcard", () => {
    it("Finds the photo and URL, resolved against the page", () => {
      const result = parseHcard(HCARD, "https://alice.example");

      assert.equal(result.photoUrl, "https://alice.example/me.jpg");
      assert.equal(result.authorUrl, "https://alice.example/about");
    });

    it("Keeps absolute URLs as they are", () => {
      const html = `<img class="u-photo" src="https://cdn.example/me.jpg">`;
      const result = parseHcard(html, "https://alice.example");

      assert.equal(result.photoUrl, "https://cdn.example/me.jpg");
    });

    it("Accepts u-uid in place of u-url", () => {
      const html = `<a class="u-uid" href="https://alice.example/">Alice</a>`;
      const result = parseHcard(html, "https://alice.example");

      assert.equal(result.authorUrl, "https://alice.example/");
    });

    it("Ignores images and links that are not microformats", () => {
      const html = `
        <img class="avatar" src="/not-me.jpg">
        <a class="nav-link" href="/not-about">Home</a>
      `;
      const result = parseHcard(html, "https://alice.example");

      assert.equal(result.photoUrl, null);
      assert.equal(result.authorUrl, null);
    });

    // `class="u-photo-large"` contains the string but is a different class.
    it("Matches whole class names only", () => {
      const html = `<img class="u-photo-large" src="/me.jpg">`;
      const result = parseHcard(html, "https://alice.example");

      assert.equal(result.photoUrl, null);
    });

    it("Finds a microformat class among several", () => {
      const html = `<img class="avatar u-photo rounded" src="/me.jpg">`;
      const result = parseHcard(html, "https://alice.example");

      assert.equal(result.photoUrl, "https://alice.example/me.jpg");
    });

    it("Returns nulls for markup with no h-card", () => {
      assert.deepEqual(parseHcard("<p>Nothing here</p>", "https://a.example"), {
        photoUrl: null,
        authorUrl: null,
      });
    });
  });

  describe("discoverAuthorData", () => {
    it("Returns nulls without a domain", async () => {
      const fetchMock = stubFetch();

      assert.deepEqual(await discoverAuthorData(""), {
        photoUrl: null,
        authorUrl: null,
      });
      assert.equal(fetchMock.mock.callCount(), 0, "makes no request");
    });

    it("Fetches a domain's homepage and returns its h-card data", async () => {
      stubFetch({ body: HCARD });

      const result = await discoverAuthorData("alice.example");

      assert.equal(result.photoUrl, "https://alice.example/me.jpg");
      assert.equal(result.authorUrl, "https://alice.example/about");
    });

    it("Serves a repeat lookup from memory without fetching again", async () => {
      const fetchMock = stubFetch({ body: HCARD });

      await discoverAuthorData("alice.example");
      await discoverAuthorData("alice.example");

      assert.equal(fetchMock.mock.callCount(), 1);
    });

    it("Writes what it finds to the database cache", async () => {
      stubFetch({ body: HCARD });

      await discoverAuthorData("alice.example", cacheCollection);
      const cached = await cacheCollection.findOne({ domain: "alice.example" });

      assert.equal(cached.photoUrl, "https://alice.example/me.jpg");
      assert.ok(cached.fetchedAt);
    });

    it("Uses a fresh database cache entry instead of fetching", async () => {
      await cacheCollection.insertOne({
        domain: "alice.example",
        photoUrl: "https://alice.example/cached.jpg",
        authorUrl: "https://alice.example/",
        fetchedAt: new Date().toISOString(),
      });
      const fetchMock = stubFetch({ body: HCARD });

      const result = await discoverAuthorData("alice.example", cacheCollection);

      assert.equal(result.photoUrl, "https://alice.example/cached.jpg");
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    // Entries older than the seven-day TTL are refetched.
    it("Refetches when the cached entry has expired", async () => {
      const eightDaysAgo = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await cacheCollection.insertOne({
        domain: "alice.example",
        photoUrl: "https://alice.example/stale.jpg",
        authorUrl: null,
        fetchedAt: eightDaysAgo,
      });
      const fetchMock = stubFetch({ body: HCARD });

      const result = await discoverAuthorData("alice.example", cacheCollection);

      assert.equal(fetchMock.mock.callCount(), 1);
      assert.equal(result.photoUrl, "https://alice.example/me.jpg");
    });

    it("Returns nulls when the homepage is not HTML", async () => {
      stubFetch({ body: "{}", contentType: "application/json" });

      assert.deepEqual(await discoverAuthorData("alice.example"), {
        photoUrl: null,
        authorUrl: null,
      });
    });

    it("Returns nulls when the homepage cannot be fetched", async () => {
      stubFetch({ ok: false });

      assert.deepEqual(await discoverAuthorData("alice.example"), {
        photoUrl: null,
        authorUrl: null,
      });
    });

    // Discovery is an enrichment step, so a network failure must not throw.
    it("Survives a failing request", async () => {
      globalThis.fetch = mock.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      mock.method(console, "log", () => {});

      assert.deepEqual(await discoverAuthorData("alice.example"), {
        photoUrl: null,
        authorUrl: null,
      });
    });
  });
});
