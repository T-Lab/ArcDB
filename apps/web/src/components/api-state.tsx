"use client";

import { AlertTriangle, KeyRound, RefreshCw, ServerOff } from "lucide-react";
import Link from "next/link";
import type { RemoteError } from "../lib/api";

export function ApiErrorState({ error }: { error: RemoteError }): React.JSX.Element {
  const denied = error.status === 401 || error.status === 403;
  const configuration = error.code === "WEB_CONFIGURATION_ERROR";
  const Icon = denied ? KeyRound : configuration ? AlertTriangle : ServerOff;
  const title = denied
    ? "Permission denied"
    : configuration
      ? "Web server configuration required"
      : "ArcDB API could not be reached";
  return (
    <div className="api-error" role="alert">
      <span className="error-icon">
        <Icon size={22} aria-hidden="true" />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{error.message}</p>
        {error.requestId ? (
          <p className="request-id">
            Request ID: <code>{error.requestId}</code>
          </p>
        ) : null}
        <div className="error-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={15} aria-hidden="true" /> Retry
          </button>
          {denied || configuration ? (
            <Link className="button button-ghost" href="/settings">
              Open settings
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
