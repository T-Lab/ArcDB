import { z } from "zod";
import { REGISTERED_EFFECT_CONNECTOR_TYPES } from "./effect-connectors.js";

const BooleanStringSchema = z.enum(["true", "false"]).transform((value) => value === "true");

const registeredConnectors = new Set<string>(REGISTERED_EFFECT_CONNECTOR_TYPES);

export const AllowedConnectorsSchema = z
  .string()
  .default("manual-receipt")
  .transform((raw, context) => {
    const values = raw.trim() === "" ? [] : raw.split(",").map((entry) => entry.trim());
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value)) {
        context.addIssue({
          code: "custom",
          message: `Connector entry ${index + 1} has an invalid name`,
        });
      } else if (!registeredConnectors.has(value)) {
        context.addIssue({
          code: "custom",
          message: `Connector ${value} is not registered by this ArcDB build`,
        });
      }
      if (seen.has(value)) {
        context.addIssue({ code: "custom", message: `Connector ${value} appears more than once` });
      }
      seen.add(value);
    }
    return values;
  });

export const ApiConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    ARCDB_HOST: z.string().default("0.0.0.0"),
    ARCDB_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    ARCDB_DATABASE_URL: z.string().url().startsWith("postgresql://"),
    ARCDB_SYSTEM_DATABASE_URL: z.string().url().startsWith("postgresql://"),
    ARCDB_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
    ARCDB_API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
    ARCDB_LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    ARCDB_S3_ENDPOINT: z.string().url(),
    ARCDB_S3_REGION: z.string().min(1).default("us-east-1"),
    ARCDB_S3_BUCKET: z.string().min(3),
    ARCDB_S3_ACCESS_KEY: z.string().min(1),
    ARCDB_S3_SECRET_KEY: z.string().min(1),
    ARCDB_S3_FORCE_PATH_STYLE: BooleanStringSchema.default(true),
    ARCDB_ALLOW_DEV_BOOTSTRAP: BooleanStringSchema.default(false),
    ARCDB_ALLOWED_CONNECTORS: AllowedConnectorsSchema,
    ARCDB_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    ARCDB_MAX_PAYLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(5 * 1024 * 1024),
  })
  .strict();

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export function readApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const selected: Record<string, string> = {};
  for (const key of Object.keys(ApiConfigSchema.shape)) {
    const value = environment[key];
    if (value !== undefined) selected[key] = value;
  }
  const config = ApiConfigSchema.parse(selected);
  if (config.ARCDB_DATABASE_URL === config.ARCDB_SYSTEM_DATABASE_URL) {
    throw new TypeError("ARCDB_DATABASE_URL and ARCDB_SYSTEM_DATABASE_URL must be distinct");
  }
  return config;
}
