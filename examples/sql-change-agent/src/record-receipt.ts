import { createClient, loadSqlConfig, required } from "./config.js";

function parseActualEffects(value: string | undefined): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ARCDB_ACTUAL_EFFECTS_JSON must contain a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

try {
  const config = loadSqlConfig();
  const effectId = required(process.env, "ARCDB_EFFECT_ID");
  const externalStatus = required(process.env, "ARCDB_EXTERNAL_STATUS");
  const transactionId = process.env.ARCDB_EXTERNAL_TRANSACTION_ID?.trim();
  const normalizedStatus = externalStatus.toUpperCase();
  const committed = ["OK", "SUCCESS", "SUCCEEDED", "COMMITTED", "APPLIED"].includes(
    normalizedStatus,
  );
  const receipt = await createClient(config).recordReceipt(effectId, {
    externalStatus,
    actualEffects: parseActualEffects(process.env.ARCDB_ACTUAL_EFFECTS_JSON),
    ...(transactionId === undefined || transactionId.length === 0
      ? {}
      : { externalTransactionId: transactionId }),
    ...(committed ? { committedAt: new Date().toISOString() } : {}),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
