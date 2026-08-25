"use client";

import { useSearchParams } from "next/navigation";

export function ProjectScopeInput(): React.JSX.Element | null {
  const projectId = useSearchParams().get("projectId");
  return projectId ? <input type="hidden" name="projectId" value={projectId} /> : null;
}
