export type NextSearchParams = Record<string, string | string[] | undefined>;

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function projectIdFrom(params: NextSearchParams): string | undefined {
  return firstParam(params.projectId)?.trim() || undefined;
}

export function isoDateTimeParam(value: string | string[] | undefined): string | undefined {
  const selected = firstParam(value)?.trim();
  if (!selected) return undefined;
  const timestamp = Date.parse(selected);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

export function withQuery(
  pathname: string,
  current: NextSearchParams,
  changes: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) if (item !== undefined && item !== "") query.append(key, item);
  }
  for (const [key, value] of Object.entries(changes)) {
    query.delete(key);
    if (value !== undefined && value !== "") query.set(key, value);
  }
  const serialized = query.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

function commonListQuery(params: NextSearchParams): Record<string, string | undefined> {
  return {
    projectId: projectIdFrom(params),
    cursor: firstParam(params.cursor)?.trim() || undefined,
    limit: firstParam(params.limit)?.trim() || "50",
  };
}

export function traceListQuery(params: NextSearchParams): Record<string, string | undefined> {
  return {
    ...commonListQuery(params),
    query: firstParam(params.query)?.trim() || undefined,
    status: firstParam(params.status)?.trim() || undefined,
    type: firstParam(params.type)?.trim() || undefined,
    runId: firstParam(params.runId)?.trim() || undefined,
    from: isoDateTimeParam(params.from),
  };
}

export function outputListQuery(params: NextSearchParams): Record<string, string | undefined> {
  return {
    ...commonListQuery(params),
    query: firstParam(params.query)?.trim() || undefined,
    lifecycleState: firstParam(params.status)?.trim() || undefined,
    outputType: firstParam(params.type)?.trim() || undefined,
    from: isoDateTimeParam(params.from),
  };
}

export function effectListQuery(params: NextSearchParams): Record<string, string | undefined> {
  return {
    ...commonListQuery(params),
    query: firstParam(params.query)?.trim() || undefined,
    status: firstParam(params.status)?.trim() || undefined,
    riskLevel: firstParam(params.riskLevel)?.trim() || undefined,
    from: isoDateTimeParam(params.from),
  };
}

export function auditListQuery(params: NextSearchParams): Record<string, string | undefined> {
  return {
    ...commonListQuery(params),
    query: firstParam(params.query)?.trim() || undefined,
    actor: firstParam(params.actor)?.trim() || undefined,
    action: firstParam(params.action)?.trim() || undefined,
    from: isoDateTimeParam(params.from),
  };
}
