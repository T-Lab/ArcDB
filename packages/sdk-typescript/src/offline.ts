import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type BufferedOperation = {
  readonly id: string;
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly attempts: number;
};

export interface OfflineBuffer {
  enqueue(operation: Omit<BufferedOperation, "id" | "createdAt" | "attempts">): Promise<string>;
  peek(limit?: number): Promise<readonly BufferedOperation[]>;
  remove(ids: readonly string[]): Promise<void>;
  update(operation: BufferedOperation): Promise<void>;
  size(): Promise<number>;
}

function createOperation(
  operation: Omit<BufferedOperation, "id" | "createdAt" | "attempts">,
): BufferedOperation {
  return {
    ...operation,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
}

export class MemoryOfflineBuffer implements OfflineBuffer {
  readonly #operations = new Map<string, BufferedOperation>();

  public async enqueue(
    operation: Omit<BufferedOperation, "id" | "createdAt" | "attempts">,
  ): Promise<string> {
    const buffered = createOperation(operation);
    this.#operations.set(buffered.id, buffered);
    return buffered.id;
  }

  public async peek(limit = 100): Promise<readonly BufferedOperation[]> {
    return [...this.#operations.values()].slice(0, Math.max(0, limit));
  }

  public async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.#operations.delete(id);
  }

  public async update(operation: BufferedOperation): Promise<void> {
    if (this.#operations.has(operation.id)) this.#operations.set(operation.id, operation);
  }

  public async size(): Promise<number> {
    return this.#operations.size;
  }
}

/**
 * A small durable buffer for Node.js agents. The complete queue is atomically replaced after each
 * change, which favors correctness and crash recovery over high-throughput ingestion. Applications
 * with sustained offline traffic should supply their own OfflineBuffer implementation.
 */
export class FileOfflineBuffer implements OfflineBuffer {
  readonly #path: string;
  #serial: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    if (path.trim().length === 0) throw new Error("Offline buffer path cannot be empty");
    this.#path = path;
  }

  public async enqueue(
    operation: Omit<BufferedOperation, "id" | "createdAt" | "attempts">,
  ): Promise<string> {
    const buffered = createOperation(operation);
    await this.#mutate((operations) => [...operations, buffered]);
    return buffered.id;
  }

  public async peek(limit = 100): Promise<readonly BufferedOperation[]> {
    await this.#serial;
    return (await this.#read()).slice(0, Math.max(0, limit));
  }

  public async remove(ids: readonly string[]): Promise<void> {
    const selected = new Set(ids);
    await this.#mutate((operations) => operations.filter(({ id }) => !selected.has(id)));
  }

  public async update(operation: BufferedOperation): Promise<void> {
    await this.#mutate((operations) =>
      operations.map((current) => (current.id === operation.id ? operation : current)),
    );
  }

  public async size(): Promise<number> {
    await this.#serial;
    return (await this.#read()).length;
  }

  async #mutate(
    mutate: (operations: readonly BufferedOperation[]) => readonly BufferedOperation[],
  ): Promise<void> {
    const next = this.#serial.then(async () => {
      const operations = await this.#read();
      await this.#write(mutate(operations));
    });
    this.#serial = next.catch(() => undefined);
    await next;
  }

  async #read(): Promise<readonly BufferedOperation[]> {
    try {
      const content = await readFile(this.#path, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) throw new Error("Offline buffer does not contain an array");
      return parsed as readonly BufferedOperation[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #write(operations: readonly BufferedOperation[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(operations)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#path);
  }
}
