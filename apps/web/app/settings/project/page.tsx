import { FolderCog } from "lucide-react";
import type { Metadata } from "next";
import { ApiErrorState } from "../../../src/components/api-state";
import { KeyValueGrid } from "../../../src/components/key-value";
import { EmptyState, PageHeader, Section } from "../../../src/components/page";
import { apiGet, asRemoteResult } from "../../../src/lib/api";
import { formatDateTime } from "../../../src/lib/format";
import { normalizeList, normalizeProject } from "../../../src/lib/normalizers";
import { ensureProjectId } from "../../../src/lib/project-scope";
import type { NextSearchParams } from "../../../src/lib/query";

export const metadata: Metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const selectedId = await ensureProjectId(params, "/settings/project");
  const result = await asRemoteResult(apiGet<unknown>("/v1/projects"));
  const projects = result.ok ? normalizeList(result.data, normalizeProject).items : [];
  const project = selectedId
    ? projects.find((item) => item.id === selectedId)
    : projects.length === 1
      ? projects[0]
      : undefined;
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Settings"
        title="Project"
        description="Read-only project identity from GET /v1/projects."
      />
      {!result.ok ? (
        <ApiErrorState error={result.error} />
      ) : project ? (
        <Section
          title={project.name}
          description={
            project.organizationName
              ? `Organization: ${project.organizationName}`
              : "Organization not returned"
          }
        >
          <KeyValueGrid
            items={[
              { label: "Project ID", value: <code>{project.id}</code> },
              { label: "Slug", value: project.slug ?? "—" },
              { label: "Organization ID", value: <code>{project.organizationId ?? "—"}</code> },
              { label: "Access role", value: project.role ?? "—" },
              { label: "Created", value: formatDateTime(project.createdAt) },
              { label: "Management", value: "Read-only in this console build" },
            ]}
          />
        </Section>
      ) : (
        <section className="panel">
          <EmptyState
            icon={FolderCog}
            title={projects.length > 1 ? "Select a project" : "No accessible projects"}
            description={
              projects.length > 1
                ? "Use the project switcher in the top bar to open project-specific settings."
                : "The projects API returned no accessible project records."
            }
          />
        </section>
      )}
    </div>
  );
}
