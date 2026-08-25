"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

export function Brand(): React.JSX.Element {
  const projectId = useSearchParams().get("projectId");
  const href = projectId ? `/overview?projectId=${encodeURIComponent(projectId)}` : "/overview";
  return (
    <Link className="brand" href={href} aria-label="ArcDB overview">
      <span className="brand-mark" aria-hidden="true">
        A
      </span>
      <span>
        <strong>ArcDB</strong>
        <small>Agent data plane</small>
      </span>
    </Link>
  );
}
