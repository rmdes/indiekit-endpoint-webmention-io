/**
 * Webmention blocklist MongoDB storage
 *
 * Domains are normalised to a bare hostname on the way in and on every
 * lookup. The moderation forms submit whatever the operator was looking at,
 * commonly a full author URL, while mentions store sourceDomain as a
 * hostname. Storing the raw value made the blocklist silently non-matching.
 */
import { normaliseDomain } from "../utils.js";

/**
 * Ensure indexes exist
 * @param {object} collection - MongoDB collection
 */
export async function ensureBlocklistIndexes(collection) {
  await collection.createIndex({ domain: 1 }, { unique: true });
}

/**
 * Add a domain to the blocklist
 * @param {object} collection - MongoDB collection
 * @param {string} domain - Domain to block
 * @param {string} reason - Reason ("spam", "privacy", "manual")
 * @param {number} mentionsHidden - Count of mentions hidden
 * @returns {Promise<boolean>} true if inserted, false if already existed
 */
export async function blockDomain(
  collection,
  domain,
  reason = "spam",
  mentionsHidden = 0,
  status = "blocked",
) {
  domain = normaliseDomain(domain) ?? domain;

  try {
    await collection.insertOne({
      domain,
      reason,
      status,
      blockedAt: new Date().toISOString(),
      mentionsHidden,
    });
    return true;
  } catch (error) {
    // Duplicate key — domain already blocked
    if (error.code === 11_000) {
      // Update reason and count
      // Re-applying an action to a listed domain also moves it between
      // quarantine and block, which is how "promote to block" works.
      await collection.updateOne(
        { domain },
        {
          $set: { reason, status },
          $inc: { mentionsHidden },
        },
      );
      return false;
    }
    throw error;
  }
}

/**
 * Remove a domain from the blocklist
 * @param {object} collection - MongoDB collection
 * @param {string} domain - Domain to unblock
 */
export async function unblockDomain(collection, domain) {
  const normalised = normaliseDomain(domain);
  // Delete both shapes: entries written before normalisation still hold the
  // raw value the operator pasted.
  await collection.deleteMany({
    domain: { $in: [domain, normalised].filter(Boolean) },
  });
}

/**
 * Get all blocked domains
 * @param {object} collection - MongoDB collection
 * @returns {Promise<Array>}
 */
export async function getBlocklist(collection) {
  return collection.find({}).sort({ blockedAt: -1 }).toArray();
}

/**
 * Check if a domain is blocked
 * @param {object} collection - MongoDB collection
 * @param {string} domain - Domain to check
 * @returns {Promise<boolean>}
 */
export async function isDomainBlocked(collection, domain) {
  const normalised = normaliseDomain(domain);
  const entry = await collection.findOne({
    domain: { $in: [domain, normalised].filter(Boolean) },
  });
  return !!entry;
}

/**
 * Split the list by what each entry actually enforces.
 *
 * The two differ in one respect, and it is the whole point of quarantine:
 * a blocked domain has its stored mentions swept hidden on every cycle, a
 * quarantined one never does. Incoming mentions are handled differently too —
 * blocked are dropped, quarantined are stored hidden for review.
 *
 * Entries written before quarantine existed carry no status and count as
 * blocked, so nothing needs migrating.
 * @param {object} collection - MongoDB collection
 * @returns {Promise<{blocked: Set<string>, quarantined: Set<string>}>} Sets
 */
export async function getModerationSets(collection) {
  const entries = await collection
    .find({}, { projection: { domain: 1, status: 1 } })
    .toArray();

  const blocked = new Set();
  const quarantined = new Set();

  for (const entry of entries) {
    const domain = normaliseDomain(entry.domain) ?? entry.domain;
    if (!domain) continue;
    (entry.status === "quarantined" ? quarantined : blocked).add(domain);
  }

  return { blocked, quarantined };
}

/**
 * Get set of all blocked domains (for efficient sync filtering)
 * @param {object} collection - MongoDB collection
 * @returns {Promise<Set<string>>}
 */
export async function getBlockedDomainSet(collection) {
  const entries = await collection
    .find({}, { projection: { domain: 1 } })
    .toArray();
  // Normalised on read as well as write, so entries stored before this was
  // fixed start matching without needing a migration.
  return new Set(
    entries.map((e) => normaliseDomain(e.domain) ?? e.domain).filter(Boolean),
  );
}
