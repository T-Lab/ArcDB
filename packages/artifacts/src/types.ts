export type ArtifactType = "text" | "markdown" | "json" | "file_tree" | "code_patch" | "sql";
export type ContentRef = string;

export interface PutOptions {
  readonly tenantId: string;
  readonly artifactType: ArtifactType;
  readonly mediaType?: string;
  readonly chunkSizeBytes?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StagedChunk {
  readonly digest: string;
  readonly byteLength: number;
}

export interface StagedArtifact {
  readonly stageId: string;
  readonly tenantId: string;
  readonly artifactType: ArtifactType;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly originalDigest: string;
  readonly chunks: readonly StagedChunk[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly stagedAt: string;
}

export interface ManifestInput {
  readonly logicalName?: string;
  readonly schemaId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ArtifactManifest {
  readonly version: 1;
  readonly tenantId: string;
  readonly artifactType: ArtifactType;
  readonly mediaType: string;
  readonly logicalName?: string;
  readonly schemaId?: string;
  readonly byteLength: number;
  readonly originalDigest: string;
  readonly chunks: readonly StagedChunk[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface JsonDiffEntry {
  readonly path: string;
  readonly operation: "add" | "remove" | "replace";
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface TextDiffHunk {
  readonly startLine: number;
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

export interface ArtifactDiff {
  readonly equal: boolean;
  readonly kind: "json" | "text" | "binary";
  readonly leftDigest: string;
  readonly rightDigest: string;
  readonly jsonChanges?: readonly JsonDiffEntry[];
  readonly textHunks?: readonly TextDiffHunk[];
}

export interface DiffOptions {
  readonly maxBytes?: number;
}

export interface GCOptions {
  readonly tenantId: string;
  readonly olderThan?: string;
  readonly dryRun?: boolean;
}

export interface GCReport {
  readonly scannedChunks: number;
  readonly reachableChunks: number;
  readonly deletedChunks: number;
  readonly reclaimedBytes: number;
  readonly dryRun: boolean;
}

export interface ArtifactStore {
  putStream(input: AsyncIterable<Uint8Array>, options: PutOptions): Promise<StagedArtifact>;
  finalize(staged: StagedArtifact, manifest: ManifestInput): Promise<ContentRef>;
  read(ref: ContentRef): AsyncIterable<Uint8Array>;
  diff(left: ContentRef, right: ContentRef, options?: DiffOptions): Promise<ArtifactDiff>;
  fork(ref: ContentRef): Promise<ContentRef>;
  collectGarbage(options: GCOptions): Promise<GCReport>;
}

export class ArtifactStoreError extends Error {
  public readonly code:
    | "INVALID_REF"
    | "NOT_FOUND"
    | "CORRUPT_ARTIFACT"
    | "ARTIFACT_TOO_LARGE"
    | "STORE_UNAVAILABLE";

  public constructor(
    code: ArtifactStoreError["code"],
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}
