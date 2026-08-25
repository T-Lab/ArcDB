import type { JobLogger } from "../../src/job-types.js";

export const silentLogger: JobLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
