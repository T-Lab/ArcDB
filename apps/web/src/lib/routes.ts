export function projectHref(pathname: string, projectId: string | undefined): string {
  if (!projectId) return pathname;
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}projectId=${encodeURIComponent(projectId)}`;
}

export function recordHref(
  collection: "traces" | "outputs" | "effects",
  id: string,
  projectId: string | undefined,
): string {
  return projectHref(`/${collection}/${encodeURIComponent(id)}`, projectId);
}
