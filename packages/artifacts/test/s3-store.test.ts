import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createS3ArtifactStore, putBytes, readBytes } from "../src/index.js";

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly lastModified: Date;
}

class FakeS3 {
  public readonly objects = new Map<string, StoredObject>();

  public async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      if (key === undefined || !(command.input.Body instanceof Uint8Array)) {
        throw new Error("invalid put");
      }
      if (command.input.IfNoneMatch === "*" && this.objects.has(key)) {
        throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
      }
      this.objects.set(key, { bytes: command.input.Body, lastModified: new Date(0) });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const value =
        command.input.Key === undefined ? undefined : this.objects.get(command.input.Key);
      if (value === undefined) {
        throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      }
      async function* body(): AsyncIterable<Uint8Array> {
        yield value.bytes;
      }
      return { Body: body() };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return {
        IsTruncated: false,
        Contents: [...this.objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([Key, value]) => ({
            Key,
            Size: value.bytes.byteLength,
            LastModified: value.lastModified,
          })),
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key !== undefined) {
          this.objects.delete(object.Key);
        }
      }
      return {};
    }
    throw new Error("unsupported command");
  }
}

function storeWith(fake: FakeS3) {
  return createS3ArtifactStore({
    bucket: "artifacts",
    region: "us-east-1",
    client: fake as unknown as S3Client,
  });
}

describe("S3 content-addressed ArtifactStore", () => {
  it("preserves original bytes, deduplicates chunks, and emits stable refs", async () => {
    const fake = new FakeS3();
    const store = storeWith(fake);
    const bytes = Buffer.from("select * from users where active = true;", "utf8");
    const options = { tenantId: "tenant-1", artifactType: "sql" as const };
    const first = await putBytes(store, bytes, options, { logicalName: "active-users.sql" });
    const objectCount = fake.objects.size;
    const second = await putBytes(store, bytes, options, { logicalName: "active-users.sql" });

    expect(second).toBe(first);
    expect(fake.objects.size).toBe(objectCount);
    expect(Buffer.from(await readBytes(store, first))).toEqual(bytes);
  });

  it("computes structured JSON diffs", async () => {
    const fake = new FakeS3();
    const store = storeWith(fake);
    const options = { tenantId: "tenant-1", artifactType: "json" as const };
    const left = await putBytes(store, Buffer.from('{"safe":true,"rows":1}'), options);
    const right = await putBytes(store, Buffer.from('{"safe":false,"rows":2}'), options);
    const result = await store.diff(left, right);

    expect(result.kind).toBe("json");
    expect(result.jsonChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/safe", operation: "replace" }),
        expect.objectContaining({ path: "/rows", operation: "replace" }),
      ]),
    );
  });

  it("garbage-collects only chunks unreachable from a finalized manifest", async () => {
    const fake = new FakeS3();
    const store = storeWith(fake);
    await putBytes(store, Buffer.from("reachable"), { tenantId: "tenant-1", artifactType: "text" });
    async function* orphan(): AsyncIterable<Uint8Array> {
      yield Buffer.from("orphan");
    }
    await store.putStream(orphan(), { tenantId: "tenant-1", artifactType: "text" });

    const report = await store.collectGarbage({
      tenantId: "tenant-1",
      olderThan: new Date().toISOString(),
      dryRun: false,
    });
    expect(report.deletedChunks).toBe(1);
    expect(report.reachableChunks).toBe(1);
  });
});
