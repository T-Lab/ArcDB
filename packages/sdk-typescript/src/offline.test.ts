import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileOfflineBuffer } from "./offline.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("FileOfflineBuffer", () => {
  it("persists operations without credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcdb-sdk-"));
    directories.push(directory);
    const path = join(directory, "queue.json");
    const buffer = new FileOfflineBuffer(path);
    const id = await buffer.enqueue({
      method: "POST",
      path: "v1/ingestion/batch",
      body: { batchId: "1" },
      headers: { "Idempotency-Key": "1" },
    });

    expect(await buffer.size()).toBe(1);
    expect((await buffer.peek())[0]?.id).toBe(id);
    expect(await readFile(path, "utf8")).not.toContain("Authorization");

    await buffer.remove([id]);
    expect(await buffer.size()).toBe(0);
  });
});
