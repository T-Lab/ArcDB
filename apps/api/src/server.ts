import { S3ArtifactStore } from "@arcdb/artifacts";
import { createDatabase } from "@arcdb/db";
import { createMetrics } from "@arcdb/observability";
import { buildApp } from "./app.js";
import { readApiConfig } from "./config.js";

const config = readApiConfig();
const database = createDatabase({
  connectionString: config.ARCDB_DATABASE_URL,
  systemConnectionString: config.ARCDB_SYSTEM_DATABASE_URL,
  applicationName: "arcdb-api",
});
try {
  await database.assertRuntimeRoleSeparation();
} catch (error) {
  await database.close();
  throw error;
}
const artifactStore = new S3ArtifactStore({
  bucket: config.ARCDB_S3_BUCKET,
  region: config.ARCDB_S3_REGION,
  endpoint: config.ARCDB_S3_ENDPOINT,
  accessKeyId: config.ARCDB_S3_ACCESS_KEY,
  secretAccessKey: config.ARCDB_S3_SECRET_KEY,
  forcePathStyle: config.ARCDB_S3_FORCE_PATH_STYLE,
});
const metrics = createMetrics({ service: "api", collectDefault: true });
const app = await buildApp({ config, database, artifactStore, metrics });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const forced = setTimeout(() => process.exit(1), 15_000);
  forced.unref();
  try {
    await app.close();
    await database.close();
    clearTimeout(forced);
  } catch (error) {
    app.log.error({ err: error }, "shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.ARCDB_HOST, port: config.ARCDB_API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, "API startup failed");
  await database.close();
  process.exitCode = 1;
}
