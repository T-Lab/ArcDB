import { z } from "zod";
import {
  addDuplicateIssue,
  DigestSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  MetadataSchema,
} from "./primitives.js";

export const OutputTypeSchema = z.enum([
  "text",
  "json",
  "markdown",
  "code_patch",
  "file_tree",
  "sql",
  "tool_plan",
  "decision",
  "dataset_record",
]);

export const OutputLifecycleStateSchema = z.enum([
  "CREATED",
  "STAGED",
  "VERIFIED",
  "APPROVED",
  "COMMITTED",
  "CONSUMED",
  "PROMOTED",
  "REJECTED",
  "STALE",
  "INVALIDATED",
  "SUPERSEDED",
]);

export const OutputObjectSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    projectId: IdentifierSchema,
    logicalId: IdentifierSchema,
    versionId: IdentifierSchema,
    outputType: OutputTypeSchema,
    schemaId: IdentifierSchema.optional(),
    contentRef: IdentifierSchema,
    contentDigest: DigestSchema,
    producerRunId: IdentifierSchema.optional(),
    producerAgentId: IdentifierSchema.optional(),
    parentVersionIds: z.array(IdentifierSchema),
    policyVersion: IdentifierSchema.optional(),
    lifecycleState: OutputLifecycleStateSchema,
    metadata: MetadataSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((output, context) => {
    addDuplicateIssue(output.parentVersionIds, context, "parentVersionIds");
    if (Date.parse(output.updatedAt) < Date.parse(output.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "updatedAt cannot precede createdAt",
        path: ["updatedAt"],
      });
    }
  });

export type OutputType = z.infer<typeof OutputTypeSchema>;
export type OutputLifecycleState = z.infer<typeof OutputLifecycleStateSchema>;
export type OutputObject = z.infer<typeof OutputObjectSchema>;
