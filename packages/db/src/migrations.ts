import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, SqlExecutor } from "./database.js";

export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

async function ensureMigrationTable(executor: SqlExecutor): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS arcdb_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrateDatabase(
  database: Database,
  directory = defaultMigrationsDirectory,
): Promise<MigrationResult> {
  const files = (await readdir(directory))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/u.test(file))
    .sort((left, right) => left.localeCompare(right));

  return database.withSystem(
    async (executor) => {
      await ensureMigrationTable(executor);
      await executor.query("SELECT pg_advisory_xact_lock(hashtext('arcdb_schema_migrations'))");
      const existing = await executor.query<{
        version: string;
        checksum: string;
        applied_at: Date;
      }>("SELECT version, checksum, applied_at FROM arcdb_schema_migrations ORDER BY version");
      const byVersion = new Map(existing.rows.map((row) => [row.version, row.checksum]));
      const applied: string[] = [];
      const alreadyApplied: string[] = [];

      for (const file of files) {
        const sql = await readFile(join(directory, file), "utf8");
        const digest = checksum(sql);
        const previous = byVersion.get(file);
        if (previous !== undefined) {
          if (previous !== digest) {
            throw new Error(`Applied migration ${file} has been modified`);
          }
          alreadyApplied.push(file);
          continue;
        }
        await executor.query(sql);
        await executor.query(
          "INSERT INTO arcdb_schema_migrations (version, checksum) VALUES ($1, $2)",
          [file, digest],
        );
        applied.push(file);
      }
      return { applied, alreadyApplied };
    },
    { isolationLevel: "SERIALIZABLE" },
  );
}

export async function listAppliedMigrations(
  database: Database,
): Promise<readonly AppliedMigration[]> {
  return database.withSystem(
    async (executor) => {
      await ensureMigrationTable(executor);
      const result = await executor.query<{
        version: string;
        checksum: string;
        applied_at: Date;
      }>("SELECT version, checksum, applied_at FROM arcdb_schema_migrations ORDER BY version");
      return result.rows.map((row) => ({
        version: row.version,
        checksum: row.checksum,
        appliedAt: row.applied_at.toISOString(),
      }));
    },
    { readOnly: true },
  );
}
