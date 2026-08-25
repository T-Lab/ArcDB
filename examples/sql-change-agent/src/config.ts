import { ArcDB } from "@arcdb/sdk";

export interface SqlExampleConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly demoId: string;
  readonly projectId: string;
}

export function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function loadSqlConfig(environment: NodeJS.ProcessEnv = process.env): SqlExampleConfig {
  const baseUrl = environment.ARCDB_API_URL?.trim() || "http://localhost:4000";
  const url = new URL(baseUrl);
  if (!url.protocol.startsWith("http")) throw new Error("ARCDB_API_URL must use HTTP(S)");
  return {
    apiKey: required(environment, "ARCDB_API_KEY"),
    baseUrl,
    demoId: environment.ARCDB_DEMO_ID?.trim() || crypto.randomUUID(),
    projectId: required(environment, "ARCDB_PROJECT_ID"),
  };
}

export function createClient(config: SqlExampleConfig): ArcDB {
  return new ArcDB(config);
}

export async function readApiResource(config: SqlExampleConfig, path: string): Promise<unknown> {
  const response = await fetch(new URL(path.replace(/^\//u, ""), `${config.baseUrl}/`), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "X-ArcDB-Project-Id": config.projectId,
    },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok)
    throw new Error(`ArcDB returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
