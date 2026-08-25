"use client";

import { Building2, ChevronsUpDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Project } from "../lib/types";

export function ProjectSwitcher({
  projects,
  unavailable,
}: {
  projects: Project[];
  unavailable?: boolean;
}): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const current = searchParams.get("projectId") ?? "";

  function selectProject(projectId: string): void {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("cursor");
    if (projectId) next.set("projectId", projectId);
    else next.delete("projectId");
    router.push(`${pathname}${next.size > 0 ? `?${next.toString()}` : ""}`);
  }

  return (
    <div className="project-switcher">
      <Building2 size={16} aria-hidden="true" />
      <label className="sr-only" htmlFor="project-switcher">
        Select project
      </label>
      <select
        id="project-switcher"
        value={current}
        disabled={unavailable || projects.length === 0}
        onChange={(event) => selectProject(event.target.value)}
      >
        {unavailable ? <option>Projects unavailable</option> : null}
        {!unavailable && projects.length === 0 ? <option>No projects</option> : null}
        {projects.map((project) => (
          <option value={project.id} key={project.id}>
            {project.organizationName
              ? `${project.organizationName} / `
              : project.organizationId
                ? `Org ${project.organizationId.slice(0, 8)} / `
                : ""}
            {project.name}
          </option>
        ))}
      </select>
      <ChevronsUpDown size={14} aria-hidden="true" />
    </div>
  );
}
