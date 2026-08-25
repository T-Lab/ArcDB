import { ApiHttpError } from "./http-error.js";

export type Cursor = {
  readonly createdAt: string;
  readonly id: string;
};

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): Cursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("createdAt" in parsed) ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      throw new Error("invalid shape");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch (error) {
    throw new ApiHttpError("INVALID_REQUEST", 400, "The pagination cursor is invalid", {
      cause: error,
    });
  }
}
