import { describe, expect, it } from "vitest";
import { PROPOSED_SQL, verifyInShadow } from "./shadow.js";

const PGLITE_TEST_TIMEOUT_MS = 15_000;

describe("SQL shadow verifier", () => {
  it(
    "executes the migration and checks old and new rows",
    async () => {
      const result = await verifyInShadow(PROPOSED_SQL);
      expect(result).toMatchObject({
        columnNullable: "NO",
        existingRowsChecked: 2,
        insertedRowsChecked: 1,
        passed: true,
      });
    },
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a migration that violates the declared contract",
    async () => {
      await expect(
        verifyInShadow("ALTER TABLE accounts ADD COLUMN risk_score INTEGER;"),
      ).resolves.toMatchObject({ passed: false });
    },
    PGLITE_TEST_TIMEOUT_MS,
  );
});
