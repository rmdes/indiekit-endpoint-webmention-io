import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it } from "node:test";

import { testDatabase } from "../../helpers/database.js";

import {
  blockDomain,
  ensureBlocklistIndexes,
  getBlocklist,
  getBlockedDomainSet,
  getModerationSets,
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

  it("blocking a full URL matches the hostname mentions are stored under", async () => {
    // The exact failure seen in production: the entry was written as
    // "https://rmendes.net" while sourceDomain held "rmendes.net", so every
    // lookup missed and the mentions stayed visible.
    await blockDomain(collection, "https://rmendes.net", "privacy");

    assert.equal(await isDomainBlocked(collection, "rmendes.net"), true);
    assert.deepEqual([...(await getBlockedDomainSet(collection))], [
      "rmendes.net",
    ]);
  });

  it("normalises entries written before the fix, on read", async () => {
    await collection.insertOne({
      domain: "https://legacy.example",
      reason: "spam",
      blockedAt: new Date().toISOString(),
      mentionsHidden: 0,
    });

    assert.ok((await getBlockedDomainSet(collection)).has("legacy.example"));
  });

  it("unblocking clears a legacy entry too", async () => {
    await collection.insertOne({
      domain: "https://legacy.example",
      reason: "spam",
      blockedAt: new Date().toISOString(),
      mentionsHidden: 0,
    });

    await unblockDomain(collection, "legacy.example");

    assert.equal(await isDomainBlocked(collection, "legacy.example"), false);
  });

  it("splits the list by what each entry enforces", async () => {
    await blockDomain(collection, "spam.example", "spam", 0, "blocked");
    await blockDomain(collection, "unsure.example", "unsure", 0, "quarantined");

    const { blocked, quarantined } = await getModerationSets(collection);

    assert.deepEqual([...blocked], ["spam.example"]);
    assert.deepEqual([...quarantined], ["unsure.example"]);
  });

  it("treats an entry with no status as blocked", async () => {
    // Rows written before quarantine existed carry no status. Counting them
    // as blocked keeps their behaviour unchanged without a migration.
    await collection.insertOne({
      domain: "legacy.example",
      reason: "spam",
      blockedAt: new Date().toISOString(),
      mentionsHidden: 0,
    });

    const { blocked, quarantined } = await getModerationSets(collection);

    assert.ok(blocked.has("legacy.example"));
    assert.equal(quarantined.size, 0);
  });

  it("promoting a quarantined domain moves it to blocked", async () => {
    await blockDomain(collection, "unsure.example", "unsure", 0, "quarantined");
    // Re-applying with the block status is what the promote button does.
    await blockDomain(collection, "unsure.example", "spam", 3, "blocked");

    const { blocked, quarantined } = await getModerationSets(collection);

    assert.ok(blocked.has("unsure.example"));
    assert.equal(quarantined.size, 0);
  });
});
