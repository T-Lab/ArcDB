export type QueryValue = string | number | boolean | undefined | null;
export type ApiQuery = Record<string, QueryValue | readonly QueryValue[]>;

export function buildApiUrl(baseUrl: string, path: string, query: ApiQuery = {}): URL {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl.replace(/\/$/u, "")}${normalizedPath}`);
  for (const [key, candidate] of Object.entries(query)) {
    // Project scope is an authentication boundary header, not a route query field.
    if (key === "projectId") continue;
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.append(key, String(value));
      }
    }
  }
  return url;
}
