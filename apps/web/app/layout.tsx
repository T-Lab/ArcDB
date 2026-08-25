import type { Metadata } from "next";
import { Shell } from "../src/components/shell";
import { apiGet, asRemoteResult } from "../src/lib/api";
import { normalizeList, normalizeProject } from "../src/lib/normalizers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ArcDB", template: "%s · ArcDB" },
  description: "Inspect agent artifacts, reliability evidence, lineage, and external consequences.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  const projectResult = await asRemoteResult(apiGet<unknown>("/v1/projects"));
  const projects = projectResult.ok
    ? normalizeList(projectResult.data, normalizeProject).items.filter(
        (project) => project.id !== "",
      )
    : [];
  return (
    <html lang="en">
      <body>
        <Shell projects={projects} projectsUnavailable={!projectResult.ok}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
