"use client";

import {
  Activity,
  Boxes,
  FileClock,
  Gauge,
  GitBranch,
  type LucideIcon,
  Settings,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

type NavigationItem = { href: string; label: string; icon: LucideIcon };
type NavigationGroup = { label: string; items: NavigationItem[] };

const groups: NavigationGroup[] = [
  { label: "Workspace", items: [{ href: "/overview", label: "Overview", icon: Gauge }] },
  {
    label: "Observe",
    items: [
      { href: "/traces", label: "Traces", icon: Activity },
      { href: "/outputs", label: "Outputs", icon: Boxes },
    ],
  },
  {
    label: "Lifecycle",
    items: [
      { href: "/operate", label: "Operate", icon: Wrench },
      { href: "/effects", label: "Effects", icon: ShieldCheck },
      { href: "/lineage", label: "Lineage & impact", icon: GitBranch },
    ],
  },
  {
    label: "Govern",
    items: [
      { href: "/audit", label: "Audit log", icon: FileClock },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Navigation(): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId");

  return (
    <nav className="side-navigation" aria-label="Primary navigation">
      {groups.map((group) => (
        <div className="nav-group" key={group.label}>
          <p>{group.label}</p>
          <ul>
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const href = projectId
                ? `${item.href}?projectId=${encodeURIComponent(projectId)}`
                : item.href;
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    className={active ? "active" : undefined}
                    href={href}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="nav-footnote">
        <span className="connection-dot" aria-hidden="true" />
        <span>Server-connected</span>
      </div>
    </nav>
  );
}
