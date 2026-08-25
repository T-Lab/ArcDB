import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectOutput,
  ListObjectsV2Command,
  type ListObjectsV2Output,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { canonicalJson, sha256 } from "./canonical.js";
import { diffJson, diffText } from "./diff.js";
import type {
  ArtifactDiff,
  ArtifactManifest,
  ArtifactStore,
  ContentRef,
  DiffOptions,
  GCOptions,
  GCReport,
  ManifestInput,
  PutOptions,
  StagedArtifact,
  StagedChunk,
} from "./types.js";
import { ArtifactStoreError } from "./types.js";

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_DIFF_LIMIT = 16 * 1024 * 1024;

export interface S3ArtifactStoreOptions {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
  readonly keyPrefix?: string;
  readonly client?: S3Client;
}

interface ParsedRef {
  readonly tenantId: string;
  readonly digest: string;
}

function tenantSegment(tenantId: string): string {
  return encodeURIComponent(tenantId);
}

function parseRef(ref: ContentRef): ParsedRef {
  const match = /^arcdb:\/\/([^/]+)\/sha256\/([a-f0-9]{64})$/u.exec(ref);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new ArtifactStoreError("INVALID_REF", `Invalid ArcDB content reference: ${ref}`);
  }
  return { tenantId: decodeURIComponent(match[1]), digest: match[2] };
}

function bodyIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === "function"
  ) {
    return body as AsyncIterable<Uint8Array>;
  }
  throw new ArtifactStoreError("CORRUPT_ARTIFACT", "Object storage returned a non-streaming body");
}

async function collectBody(body: unknown, maxBytes = DEFAULT_DIFF_LIMIT): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of bodyIterable(body)) {
    const bytes = Buffer.from(part);
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw new ArtifactStoreError("ARTIFACT_TOO_LARGE", `Artifact exceeds ${maxBytes} bytes`);
    }
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = "name" in error ? error.name : undefined;
  const status =
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata
      ? error.$metadata.httpStatusCode
      : undefined;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    error.$metadata.httpStatusCode === 412
  );
}

function parseManifest(bytes: Uint8Array, expectedTenant: string): ArtifactManifest {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<ArtifactManifest>;
    if (
      parsed.version !== 1 ||
      parsed.tenantId !== expectedTenant ||
      typeof parsed.originalDigest !== "string" ||
      !Array.isArray(parsed.chunks) ||
      typeof parsed.artifactType !== "string" ||
      typeof parsed.mediaType !== "string" ||
      typeof parsed.byteLength !== "number" ||
      parsed.metadata === null ||
      typeof parsed.metadata !== "object"
    ) {
      throw new Error("invalid manifest shape");
    }
    for (const chunk of parsed.chunks) {
      if (
        typeof chunk !== "object" ||
        chunk === null ||
        !("digest" in chunk) ||
        typeof chunk.digest !== "string" ||
        !("byteLength" in chunk) ||
        typeof chunk.byteLength !== "number"
      ) {
        throw new Error("invalid chunk entry");
      }
    }
    return parsed as ArtifactManifest;
  } catch (error) {
    throw new ArtifactStoreError("CORRUPT_ARTIFACT", "Artifact manifest is invalid", {
      cause: error,
    });
  }
}

function defaultMediaType(type: PutOptions["artifactType"]): string {
  switch (type) {
    case "json":
    case "file_tree":
      return "application/json";
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "sql":
      return "application/sql; charset=utf-8";
    case "code_patch":
      return "text/x-diff; charset=utf-8";
    case "text":
      return "text/plain; charset=utf-8";
  }
}

export class S3ArtifactStore implements ArtifactStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;

  public constructor(options: S3ArtifactStoreOptions) {
    this.#bucket = options.bucket;
    this.#prefix = options.keyPrefix?.replace(/^\/+|\/+$/gu, "") ?? "arcdb";
    const config: S3ClientConfig = {
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? false,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.accessKeyId === undefined || options.secretAccessKey === undefined
        ? {}
        : {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }),
    };
    this.#client = options.client ?? new S3Client(config);
  }

  #chunkKey(tenantId: string, digest: string): string {
    return `${this.#prefix}/${tenantSegment(tenantId)}/chunks/sha256/${digest}`;
  }

  #manifestKey(tenantId: string, digest: string): string {
    return `${this.#prefix}/${tenantSegment(tenantId)}/manifests/sha256/${digest}.json`;
  }

  async #putImmutable(key: string, body: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          IfNoneMatch: "*",
          ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
        }),
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw new ArtifactStoreError("STORE_UNAVAILABLE", "Unable to persist artifact object", {
          cause: error,
        });
      }
    }
  }

  public async putStream(
    input: AsyncIterable<Uint8Array>,
    options: PutOptions,
  ): Promise<StagedArtifact> {
    const chunkSize = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < 64 * 1024 || chunkSize > 64 * 1024 * 1024) {
      throw new TypeError("chunkSizeBytes must be between 64 KiB and 64 MiB");
    }
    const chunks: StagedChunk[] = [];
    const originalHash = createHash("sha256");
    let pending = Buffer.alloc(0);
    let totalBytes = 0;

    const persist = async (bytes: Buffer): Promise<void> => {
      const digest = sha256(bytes);
      await this.#putImmutable(
        this.#chunkKey(options.tenantId, digest),
        bytes,
        "application/octet-stream",
      );
      chunks.push({ digest, byteLength: bytes.byteLength });
    };

    for await (const value of input) {
      const bytes = Buffer.from(value);
      originalHash.update(bytes);
      totalBytes += bytes.byteLength;
      pending = Buffer.concat([pending, bytes]);
      while (pending.byteLength >= chunkSize) {
        await persist(pending.subarray(0, chunkSize));
        pending = pending.subarray(chunkSize);
      }
    }
    if (pending.byteLength > 0 || chunks.length === 0) {
      await persist(pending);
    }

    return {
      stageId: randomUUID(),
      tenantId: options.tenantId,
      artifactType: options.artifactType,
      mediaType: options.mediaType ?? defaultMediaType(options.artifactType),
      byteLength: totalBytes,
      originalDigest: `sha256:${originalHash.digest("hex")}`,
      chunks,
      metadata: { ...(options.metadata ?? {}) },
      stagedAt: new Date().toISOString(),
    };
  }

  public async finalize(staged: StagedArtifact, input: ManifestInput): Promise<ContentRef> {
    const manifest: ArtifactManifest = {
      version: 1,
      tenantId: staged.tenantId,
      artifactType: staged.artifactType,
      mediaType: staged.mediaType,
      ...(input.logicalName === undefined ? {} : { logicalName: input.logicalName }),
      ...(input.schemaId === undefined ? {} : { schemaId: input.schemaId }),
      byteLength: staged.byteLength,
      originalDigest: staged.originalDigest,
      chunks: staged.chunks,
      metadata: { ...staged.metadata, ...(input.metadata ?? {}) },
    };
    const bytes = Buffer.from(canonicalJson(manifest), "utf8");
    const digest = sha256(bytes);
    await this.#putImmutable(
      this.#manifestKey(staged.tenantId, digest),
      bytes,
      "application/vnd.arcdb.manifest+json",
    );
    return `arcdb://${encodeURIComponent(staged.tenantId)}/sha256/${digest}`;
  }

  async #manifest(ref: ContentRef): Promise<ArtifactManifest> {
    const parsed = parseRef(ref);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#manifestKey(parsed.tenantId, parsed.digest),
        }),
      );
      const bytes = await collectBody(response.Body);
      if (sha256(bytes) !== parsed.digest) {
        throw new ArtifactStoreError(
          "CORRUPT_ARTIFACT",
          "Manifest digest does not match its reference",
        );
      }
      return parseManifest(bytes, parsed.tenantId);
    } catch (error) {
      if (error instanceof ArtifactStoreError) {
        throw error;
      }
      if (isNotFound(error)) {
        throw new ArtifactStoreError("NOT_FOUND", `Artifact not found: ${ref}`);
      }
      throw new ArtifactStoreError("STORE_UNAVAILABLE", "Unable to read artifact manifest", {
        cause: error,
      });
    }
  }

  public async *read(ref: ContentRef): AsyncIterable<Uint8Array> {
    const parsed = parseRef(ref);
    const manifest = await this.#manifest(ref);
    const fullHash = createHash("sha256");
    let size = 0;
    for (const chunk of manifest.chunks) {
      let response: GetObjectOutput;
      try {
        response = await this.#client.send(
          new GetObjectCommand({
            Bucket: this.#bucket,
            Key: this.#chunkKey(parsed.tenantId, chunk.digest),
          }),
        );
      } catch (error) {
        throw new ArtifactStoreError(
          isNotFound(error) ? "CORRUPT_ARTIFACT" : "STORE_UNAVAILABLE",
          `Unable to read artifact chunk ${chunk.digest}`,
          { cause: error },
        );
      }
      const bytes = await collectBody(response.Body, chunk.byteLength + 1);
      if (bytes.byteLength !== chunk.byteLength || sha256(bytes) !== chunk.digest) {
        throw new ArtifactStoreError(
          "CORRUPT_ARTIFACT",
          `Chunk ${chunk.digest} failed verification`,
        );
      }
      fullHash.update(bytes);
      size += bytes.byteLength;
      yield bytes;
    }
    if (
      size !== manifest.byteLength ||
      `sha256:${fullHash.digest("hex")}` !== manifest.originalDigest
    ) {
      throw new ArtifactStoreError("CORRUPT_ARTIFACT", "Artifact root digest failed verification");
    }
  }

  public async diff(
    left: ContentRef,
    right: ContentRef,
    options: DiffOptions = {},
  ): Promise<ArtifactDiff> {
    const [leftManifest, rightManifest] = await Promise.all([
      this.#manifest(left),
      this.#manifest(right),
    ]);
    if (leftManifest.originalDigest === rightManifest.originalDigest) {
      return {
        equal: true,
        kind: leftManifest.artifactType === "json" ? "json" : "text",
        leftDigest: leftManifest.originalDigest,
        rightDigest: rightManifest.originalDigest,
      };
    }
    const limit = options.maxBytes ?? DEFAULT_DIFF_LIMIT;
    const [leftBytes, rightBytes] = await Promise.all([
      collectBody(this.read(left), limit),
      collectBody(this.read(right), limit),
    ]);
    if (leftManifest.artifactType === "json" && rightManifest.artifactType === "json") {
      const jsonChanges = diffJson(
        JSON.parse(Buffer.from(leftBytes).toString("utf8")),
        JSON.parse(Buffer.from(rightBytes).toString("utf8")),
      );
      return {
        equal: false,
        kind: "json",
        leftDigest: leftManifest.originalDigest,
        rightDigest: rightManifest.originalDigest,
        jsonChanges,
      };
    }
    if (
      leftManifest.mediaType.startsWith("text/") ||
      rightManifest.mediaType.startsWith("text/") ||
      ["sql", "markdown", "code_patch", "text"].includes(leftManifest.artifactType)
    ) {
      return {
        equal: false,
        kind: "text",
        leftDigest: leftManifest.originalDigest,
        rightDigest: rightManifest.originalDigest,
        textHunks: diffText(
          Buffer.from(leftBytes).toString("utf8"),
          Buffer.from(rightBytes).toString("utf8"),
        ),
      };
    }
    return {
      equal: false,
      kind: "binary",
      leftDigest: leftManifest.originalDigest,
      rightDigest: rightManifest.originalDigest,
    };
  }

  public async fork(ref: ContentRef): Promise<ContentRef> {
    await this.#manifest(ref);
    return ref;
  }

  public async collectGarbage(options: GCOptions): Promise<GCReport> {
    const tenant = tenantSegment(options.tenantId);
    const manifestPrefix = `${this.#prefix}/${tenant}/manifests/sha256/`;
    const chunkPrefix = `${this.#prefix}/${tenant}/chunks/sha256/`;
    const reachable = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const page: ListObjectsV2Output = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: manifestPrefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined) {
          continue;
        }
        const response = await this.#client.send(
          new GetObjectCommand({ Bucket: this.#bucket, Key: object.Key }),
        );
        const manifest = parseManifest(await collectBody(response.Body), options.tenantId);
        for (const chunk of manifest.chunks) {
          reachable.add(this.#chunkKey(options.tenantId, chunk.digest));
        }
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    const cutoff =
      options.olderThan === undefined
        ? Date.now() - 24 * 60 * 60 * 1_000
        : Date.parse(options.olderThan);
    if (!Number.isFinite(cutoff)) {
      throw new TypeError("olderThan must be an ISO datetime");
    }
    const candidates: { readonly key: string; readonly size: number }[] = [];
    let scannedChunks = 0;
    continuationToken = undefined;
    do {
      const page: ListObjectsV2Output = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: chunkPrefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined) {
          continue;
        }
        scannedChunks += 1;
        if (!reachable.has(object.Key) && (object.LastModified?.getTime() ?? 0) < cutoff) {
          candidates.push({ key: object.Key, size: object.Size ?? 0 });
        }
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    const dryRun = options.dryRun ?? true;
    if (!dryRun) {
      for (let offset = 0; offset < candidates.length; offset += 1_000) {
        await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: {
              Quiet: true,
              Objects: candidates.slice(offset, offset + 1_000).map(({ key }) => ({ Key: key })),
            },
          }),
        );
      }
    }
    return {
      scannedChunks,
      reachableChunks: reachable.size,
      deletedChunks: dryRun ? 0 : candidates.length,
      reclaimedBytes: dryRun
        ? 0
        : candidates.reduce((total, candidate) => total + candidate.size, 0),
      dryRun,
    };
  }
}

export function createS3ArtifactStore(options: S3ArtifactStoreOptions): S3ArtifactStore {
  return new S3ArtifactStore(options);
}

export async function putBytes(
  store: ArtifactStore,
  bytes: Uint8Array,
  options: PutOptions,
  manifest: ManifestInput = {},
): Promise<ContentRef> {
  async function* source(): AsyncIterable<Uint8Array> {
    yield bytes;
  }
  const staged = await store.putStream(source(), options);
  return store.finalize(staged, manifest);
}

export async function readBytes(
  store: ArtifactStore,
  ref: ContentRef,
  maxBytes = DEFAULT_DIFF_LIMIT,
): Promise<Uint8Array> {
  return collectBody(store.read(ref), maxBytes);
}
