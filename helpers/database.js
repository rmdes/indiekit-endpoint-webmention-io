import { getMongodbClient } from "@indiekit/util";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Local stand-in for `@indiekit-test/database`, a private workspace package in
 * the Indiekit monorepo that cannot be depended on from here. Identical to it,
 * so a test written against this moves upstream by changing one import.
 *
 * The MongoDB version comes from `@indiekit/util`, which is where Indiekit
 * pins it, rather than being pinned again here.
 * @returns {Promise<object>} Test database
 */
export const testDatabase = async () => {
  const mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  const { client } = await getMongodbClient(mongoUri);
  const database = await client.db();

  return { client, database, mongoServer, mongoUri };
};
