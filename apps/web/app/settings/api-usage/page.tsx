import "server-only";
import { KeyRound } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState, PageHeader, Section } from "../../../src/components/page";
import { ensureProjectId } from "../../../src/lib/project-scope";
import type { NextSearchParams } from "../../../src/lib/query";

export const metadata: Metadata = { title: "API access" };

export default async function ApiUsagePage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = await ensureProjectId(params, "/settings/api-usage");
  const apiConfigured = Boolean(
    process.env.ARCDB_API_URL?.trim() && process.env.ARCDB_API_KEY?.trim(),
  );
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Settings"
        title="API access"
        description="The console authenticates from the Next.js server. ARCDB_API_KEY is never serialized into browser props or requests."
      />
      <Section
        title="Server-side connection"
        description="Credential presence only; secret values are never displayed"
      >
        <div className="panel-body">
          <span className={`status-badge ${apiConfigured ? "status-positive" : "status-negative"}`}>
            <span className="status-indicator" />
            {apiConfigured ? "Configured" : "Not configured"}
          </span>
          <p className="page-description">
            Set <code>ARCDB_API_URL</code> and <code>ARCDB_API_KEY</code> in the web server
            environment, then restart the service.
          </p>
        </div>
      </Section>
      <section className="panel" style={{ marginTop: 12 }}>
        <EmptyState
          icon={KeyRound}
          title="Per-key usage data is not available"
          description="The API exposes key management endpoints, but this console does not yet expose those controls, usage totals, or rate-limit history. It does not present fabricated charts."
          code={`curl "$ARCDB_API_URL/v1/traces${projectId ? `?projectId=${projectId}` : ""}" \\\n  -H "Authorization: Bearer $ARCDB_API_KEY"`}
        />
      </section>
    </div>
  );
}
