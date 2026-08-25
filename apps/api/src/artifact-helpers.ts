import type { ArtifactStore, ArtifactType } from "@arcdb/artifacts";
import { canonicalize } from "@arcdb/contracts";
import { ApiHttpError } from "./http-error.js";

function artifactType(outputType: string, content: unknown): ArtifactType {
  if (
    outputType === "text" ||
    outputType === "markdown" ||
    outputType === "json" ||
    outputType === "file_tree" ||
    outputType === "code_patch" ||
    outputType === "sql"
  ) {
    return outputType;
  }
  return typeof content === "string" ? "text" : "json";
}

function bytesFor(content: unknown): Uint8Array {
  return Buffer.from(typeof content === "string" ? content : canonicalize(content), "utf8");
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export async function storeArtifact(
  store: ArtifactStore,
  input: {
    readonly tenantId: string;
    readonly logicalName: string;
    readonly outputType: string;
    readonly content: unknown;
    readonly schemaId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<{
  readonly ref: string;
  readonly originalDigest: string;
  readonly byteLength: number;
  readonly chunkCount: number;
  readonly mediaType: string;
}> {
  const bytes = bytesFor(input.content);
  const staged = await store.putStream(oneChunk(bytes), {
    tenantId: input.tenantId,
    artifactType: artifactType(input.outputType, input.content),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
  const ref = await store.finalize(staged, {
    logicalName: input.logicalName,
    ...(input.schemaId === undefined ? {} : { schemaId: input.schemaId }),
  });
  return {
    ref,
    originalDigest: staged.originalDigest,
    byteLength: staged.byteLength,
    chunkCount: staged.chunks.length,
    mediaType: staged.mediaType,
  };
}

export async function readArtifact(
  store: ArtifactStore,
  ref: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of store.read(ref)) {
    size += part.byteLength;
    if (size > maxBytes) {
      throw new ApiHttpError(
        "INVALID_REQUEST",
        413,
        `Artifact is larger than the ${maxBytes}-byte response limit`,
      );
    }
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts).toString("utf8");
}
