import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type SchemaMigrationIdentity = {
  readonly checksum: string;
  readonly version: string;
};

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

async function loadCurrentSchemaMigration(): Promise<SchemaMigrationIdentity> {
  const versions = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/u.test(file))
    .sort((left, right) => left.localeCompare(right));
  const version = versions.at(-1);
  if (version === undefined) {
    throw new Error("ArcDB has no packaged schema migration");
  }
  const sql = await readFile(join(migrationsDirectory, version), "utf8");
  return {
    version,
    checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
  };
}

/** The exact migration the running binary requires for readiness. */
export const CURRENT_SCHEMA_MIGRATION = await loadCurrentSchemaMigration();
