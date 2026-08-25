function toneFor(value: string): string {
  const normalized = value.toUpperCase();
  if (
    [
      "PASS",
      "OK",
      "SUCCESS",
      "SUCCEEDED",
      "FRESH",
      "VERIFIED",
      "APPROVED",
      "PROMOTED",
      "COMMITTED",
      "RESOLVED",
    ].includes(normalized)
  )
    return "positive";
  if (["FAILED", "FAIL", "ERROR", "REJECTED", "INVALIDATED", "CRITICAL"].includes(normalized))
    return "negative";
  if (
    [
      "STALE",
      "UNKNOWN",
      "EXECUTING",
      "PREPARED",
      "PENDING",
      "MEDIUM",
      "HIGH",
      "RECONCILIATION_REQUIRED",
      "REMEDIATION_REQUIRED",
      "COMPENSATION_PENDING",
    ].includes(normalized)
  )
    return "warning";
  if (["CREATED", "STAGED", "LOW", "CONSUMED", "SUPERSEDED", "COMPENSATED"].includes(normalized))
    return "neutral";
  return "default";
}

export function StatusBadge({
  value,
  prefix,
}: {
  value: string;
  prefix?: string;
}): React.JSX.Element {
  return (
    <span className={`status-badge status-${toneFor(value)}`}>
      <span className="status-indicator" aria-hidden="true" />
      {prefix ? `${prefix}: ` : ""}
      {value.replaceAll("_", " ")}
    </span>
  );
}
