import { describe, expect, it } from "vitest";
import { createMetrics, getLogContext, withLogContext } from "../src/index.js";

describe("observability primitives", () => {
  it("propagates request and tenant context through async work", async () => {
    await withLogContext({ requestId: "req-1", tenantId: "tenant-1" }, async () => {
      await Promise.resolve();
      expect(getLogContext()).toMatchObject({ requestId: "req-1", tenantId: "tenant-1" });
    });
  });

  it("renders isolated Prometheus metrics", async () => {
    const metrics = createMetrics({ service: "test" });
    metrics.observeJobTransition("run_verifier", "PENDING", "RUNNING");
    const rendered = await metrics.render();
    expect(rendered.body).toContain("arcdb_job_transitions_total");
    expect(rendered.body).toContain('job_type="run_verifier"');
  });
});
