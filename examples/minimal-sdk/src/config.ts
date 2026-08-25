export interface ExampleConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly demoId: string;
  readonly projectId: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ExampleConfig {
  const baseUrl = environment.ARCDB_API_URL?.trim() || "http://localhost:4000";
  const parsedUrl = new URL(baseUrl);
  if (!parsedUrl.protocol.startsWith("http")) {
    throw new Error("ARCDB_API_URL must use HTTP(S)");
  }
  return {
    apiKey: required(environment, "ARCDB_API_KEY"),
    baseUrl,
    demoId: environment.ARCDB_DEMO_ID?.trim() || new Date().toISOString().replaceAll(/\D/gu, ""),
    projectId: required(environment, "ARCDB_PROJECT_ID"),
  };
}
