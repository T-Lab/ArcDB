import "server-only";

import { redirect } from "next/navigation";
import { apiGet, asRemoteResult } from "./api";
import { normalizeList, normalizeProject } from "./normalizers";
import { type NextSearchParams, projectIdFrom, withQuery } from "./query";

export async function ensureProjectId(
  params: NextSearchParams,
  pathname: string,
): Promise<string | undefined> {
  const selected = projectIdFrom(params);
  if (selected) return selected;

  const projects = await asRemoteResult(apiGet<unknown>("/v1/projects"));
  if (!projects.ok) return undefined;
  const firstProject = normalizeList(projects.data, normalizeProject).items.find(
    (project) => project.id !== "",
  );
  if (!firstProject) return undefined;
  redirect(withQuery(pathname, params, { projectId: firstProject.id, cursor: undefined }));
}
