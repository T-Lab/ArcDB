import { createDatabase } from "../database.js";
import { migrateDatabase } from "../migrations.js";

const connectionString =
  process.env.ARCDB_ADMIN_DATABASE_URL ??
  process.env.ARCDB_DATABASE_URL ??
  process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("ARCDB_ADMIN_DATABASE_URL, ARCDB_DATABASE_URL, or DATABASE_URL is required");
}

const database = createDatabase({
  connectionString,
  systemConnectionString: connectionString,
  applicationName: "arcdb-migrate",
  max: 2,
});
try {
  const result = await migrateDatabase(database);
  process.stdout.write(`${JSON.stringify({ event: "database_migrated", ...result })}\n`);
} finally {
  await database.close();
}
