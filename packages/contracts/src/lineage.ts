import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./primitives.js";

export const LineageEdgeTypeSchema = z.enum([
  "PRODUCED_BY",
  "DERIVED_FROM",
  "READ_FROM",
  "VERIFIED_BY",
  "CONSUMED_BY",
  "CAUSED",
  "SUPERSEDES",
  "COMPENSATED_BY",
  "REMEDIATED_BY",
]);

export const LineageSelectorKindSchema = z.enum([
  "json_path",
  "file",
  "symbol",
  "table_column",
  "record",
  "unknown",
]);

export const LineageSelectorSchema = z
  .object({
    kind: LineageSelectorKindSchema,
    value: z.string().trim().min(1).max(4096),
  })
  .strict()
  .superRefine((selector, context) => {
    if (selector.kind === "unknown" && selector.value !== "*") {
      context.addIssue({
        code: "custom",
        message: 'unknown selectors must use value "*"',
        path: ["value"],
      });
    }
  });

export const LineageEdgeSchema = z
  .object({
    id: IdentifierSchema,
    sourceVersionId: IdentifierSchema,
    targetVersionId: IdentifierSchema,
    edgeType: LineageEdgeTypeSchema,
    selector: LineageSelectorSchema.optional(),
    transferFunction: IdentifierSchema.optional(),
    inferred: z.boolean(),
    confidence: z.number().min(0).max(1).optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((edge, context) => {
    if (!edge.inferred && edge.confidence !== undefined) {
      context.addIssue({
        code: "custom",
        message: "confidence is only valid for inferred edges",
        path: ["confidence"],
      });
    }
  });

export type LineageEdgeType = z.infer<typeof LineageEdgeTypeSchema>;
export type LineageSelectorKind = z.infer<typeof LineageSelectorKindSchema>;
export type LineageSelector = z.infer<typeof LineageSelectorSchema>;
export type LineageEdge = z.infer<typeof LineageEdgeSchema>;
