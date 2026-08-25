import { BarChart3, Cable, FolderCog, KeyRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "../../src/components/page";
import { ensureProjectId } from "../../src/lib/project-scope";
import type { NextSearchParams } from "../../src/lib/query";
import { projectHref } from "../../src/lib/routes";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = await ensureProjectId(params, "/settings");
  const cards = [
    {
      href: "/settings/project",
      title: "Project",
      description: "Inspect the selected project, organization, and your access role.",
      icon: FolderCog,
      status: "Available",
    },
    {
      href: "/settings/api-usage",
      title: "API access",
      description: "Verify the server-side API boundary and find runnable request examples.",
      icon: KeyRound,
      status: "Available",
    },
  ];
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Govern"
        title="Settings"
        description="Self-hosted ArcDB console configuration. Unsupported management surfaces are labeled explicitly."
      />
      <div className="settings-grid">
        {cards.map(({ href, title, description, icon: Icon, status }) => (
          <Link className="settings-card" href={projectHref(href, projectId)} key={href}>
            <Icon size={22} />
            <h2>{title}</h2>
            <p>{description}</p>
            <span>{status} →</span>
          </Link>
        ))}
        <article className="settings-card" aria-disabled="true">
          <Cable size={22} />
          <h2>Connectors</h2>
          <p>
            Connector management requires write endpoints and is not available in this read-only
            console build.
          </p>
          <small className="unavailable-label">Not implemented</small>
        </article>
        <article className="settings-card" aria-disabled="true">
          <BarChart3 size={22} />
          <h2>Usage analytics</h2>
          <p>
            Per-key usage and rate-limit metrics require a dedicated API endpoint that is not part
            of the current contract.
          </p>
          <small className="unavailable-label">Endpoint unavailable</small>
        </article>
      </div>
    </div>
  );
}
