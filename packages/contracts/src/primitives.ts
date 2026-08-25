import { z } from "zod";

export const IdentifierSchema = z.string().trim().min(1).max(512);
export const DigestSchema = z
  .string()
  .trim()
  .regex(/^(?:[a-z0-9][a-z0-9_-]*:)?[a-fA-F0-9]{32,}$/u, "Expected a content digest");
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const MetadataSchema = z.record(z.string(), z.unknown());

export function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function addDuplicateIssue(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  field: string,
): void {
  if (!hasUniqueValues(values)) {
    context.addIssue({
      code: "custom",
      message: `${field} must not contain duplicate values`,
      path: [field],
    });
  }
}
