import { describe, expect, it } from "vitest";
import { PROPOSED_SQL, verifyInShadow } from "./shadow.js";

describe("SQL shadow verifier", () => {
  it("executes the migration and checks old and new rows", async () => {
    const result = await verifyInShadow(PROPOSED_SQL);
    expect(result).toMatchObject({
      columnNullable: "NO",
      existingRowsChecked: 2,
      insertedRowsChecked: 1,
      passed: true,
    });
  });

  it("rejects a migration that violates the declared contract", async () => {
    await expect(
      verifyInShadow("ALTER TABLE accounts ADD COLUMN risk_score INTEGER;"),
    ).resolves.toMatchObject({ passed: false });
  });
});
