import { PGlite } from "@electric-sql/pglite";

export const PROPOSED_SQL =
  "ALTER TABLE accounts ADD COLUMN risk_score INTEGER DEFAULT 0 NOT NULL;";

export interface ShadowVerification {
  readonly columnDefault: string;
  readonly columnNullable: string;
  readonly existingRowsChecked: number;
  readonly insertedRowsChecked: number;
  readonly passed: boolean;
}

type ColumnRow = { column_default: string | null; is_nullable: string };
type AccountRow = { id: number; risk_score: number };

/** Executes the exact proposed migration against an isolated in-memory PostgreSQL instance. */
export async function verifyInShadow(sql = PROPOSED_SQL): Promise<ShadowVerification> {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE accounts (id integer PRIMARY KEY, email text NOT NULL);
      INSERT INTO accounts (id, email) VALUES (1, 'ada@example.test'), (2, 'grace@example.test');
    `);
    await database.exec(sql);
    const columns = await database.query<ColumnRow>(`
      SELECT column_default, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'risk_score'
    `);
    await database.exec("INSERT INTO accounts (id, email) VALUES (3, 'linus@example.test');");
    const rows = await database.query<AccountRow>(
      "SELECT id, risk_score FROM accounts ORDER BY id",
    );
    const column = columns.rows[0];
    if (column === undefined) throw new Error("Migration did not create accounts.risk_score");
    const existing = rows.rows.filter(({ id }) => id <= 2);
    const inserted = rows.rows.filter(({ id }) => id === 3);
    const passed =
      column.is_nullable === "NO" &&
      existing.length === 2 &&
      inserted.length === 1 &&
      rows.rows.every(({ risk_score }) => risk_score === 0);
    return {
      columnDefault: column.column_default ?? "",
      columnNullable: column.is_nullable,
      existingRowsChecked: existing.length,
      insertedRowsChecked: inserted.length,
      passed,
    };
  } finally {
    await database.close();
  }
}
