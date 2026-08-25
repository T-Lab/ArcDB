import { CircleHelp, Search } from "lucide-react";
import Link from "next/link";
import type { Project } from "../lib/types";
import { Brand } from "./brand";
import { Navigation } from "./navigation";
import { ProjectScopeInput } from "./project-scope-input";
import { ProjectSwitcher } from "./project-switcher";

export function Shell({
  projects,
  projectsUnavailable,
  children,
}: {
  projects: Project[];
  projectsUnavailable: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <Brand />
        <ProjectSwitcher projects={projects} unavailable={projectsUnavailable} />
        <form
          className="global-search"
          action="/traces"
          method="get"
          aria-label="Global trace search"
        >
          <ProjectScopeInput />
          <Search size={15} aria-hidden="true" />
          <label className="sr-only" htmlFor="global-search">
            Search traces
          </label>
          <input id="global-search" name="query" placeholder="Search traces…" autoComplete="off" />
          <kbd>/</kbd>
        </form>
        <Link className="icon-link" href="/settings" aria-label="Help and configuration">
          <CircleHelp size={18} aria-hidden="true" />
        </Link>
        <div className="avatar" role="img" aria-label="Self-hosted ArcDB">
          AR
        </div>
      </header>
      <aside className="sidebar">
        <Navigation />
      </aside>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
