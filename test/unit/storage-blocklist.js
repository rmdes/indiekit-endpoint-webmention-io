import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it } from "node:test";

import { testDatabase } from "../../helpers/database.js";

import {
  blockDomain,
  ensureBlocklistIndexes,
  getBlocklist,
  getBlockedDomainSet,
  isDomainBlocked,
  unblockDomain,
} from "../../lib/storage/blocklist.js";

const { client, database, mongoServer } = await testDatabase();
const collection = database.collection("webmentionBlocklist");

describe("endpoint-webmention-io/lib/storage/blocklist", () => {
  beforeEach(async () => {
    await collection.deleteMany({});
    await ensureBlocklistIndexes(collection);
  });

  after(async () => {
    await client.close();
    await mongoServer.stop();
  });

  it("Blocks a domain", async () => {
    const result = await blockDomain(collection, "spam.example", "spam", 3);
    const entry = await collection.findOne({ domain: "spam.example" });

    assert.equal(result, true);
    assert.equal(entry.reason, "spam");
    assert.equal(entry.mentionsHidden, 3);
    assert.ok(entry.blockedAt);
  });

  it("Blocks a domain with default reason and count", async () => {
    await blockDomain(collection, "spam.example");
    const entry = await collection.findOne({ domain: "spam.example" });

    assert.equal(entry.reason, "spam");
    assert.equal(entry.mentionsHidden, 0);
  });

  it("Updates reason and accumulates count for a blocked domain", async () => {
    await blockDomain(collection, "spam.example", "spam", 3);
    const result = await blockDomain(collection, "spam.example", "privacy", 4);
    const entries = await collection.find({}).toArray();

    assert.equal(result, false);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reason, "privacy");
    assert.equal(entries[0].mentionsHidden, 7);
  });

  it("Throws error other than duplicate domain", async () => {
    await assert.rejects(
      blockDomain(
        {
          async insertOne() {
            throw Object.assign(new Error("Connection refused"), { code: 89 });
          },
        },
        "spam.example",
      ),
      { message: "Connection refused" },
    );
  });

  it("Unblocks a domain", async () => {
    await blockDomain(collection, "spam.example");
    await unblockDomain(collection, "spam.example");

    assert.equal(await collection.countDocuments(), 0);
  });

  it("Checks if a domain is blocked", async () => {
    await blockDomain(collection, "spam.example");

    assert.equal(await isDomainBlocked(collection, "spam.example"), true);
    assert.equal(await isDomainBlocked(collection, "other.example"), false);
  });

  it("Gets blocked domains, most recently blocked first", async () => {
    await collection.insertMany([
      { domain: "older.example", blockedAt: "2026-01-01T00:00:00.000Z" },
      { domain: "newer.example", blockedAt: "2026-06-01T00:00:00.000Z" },
    ]);

    const result = await getBlocklist(collection);

    assert.deepEqual(
      result.map((entry) => entry.domain),
      ["newer.example", "older.example"],
    );
  });

  it("Gets set of blocked domains", async () => {
    await blockDomain(collection, "one.example");
    await blockDomain(collection, "two.example");

    const result = await getBlockedDomainSet(collection);

    assert.ok(result instanceof Set);
    assert.deepEqual([...result].sort(), ["one.example", "two.example"]);
  });
});
