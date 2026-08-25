"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    console.error("ArcDB web render failed", error);
  }, [error]);
  return (
    <div className="page-container">
      <div className="api-error" role="alert">
        <span className="error-icon">
          <AlertTriangle size={22} aria-hidden="true" />
        </span>
        <div>
          <h2>This view could not be rendered</h2>
          <p>
            The failure was recorded in the web server logs. Retry the request or inspect the
            request digest below.
          </p>
          {error.digest ? (
            <p className="request-id">
              Digest: <code>{error.digest}</code>
            </p>
          ) : null}
          <div className="error-actions">
            <button className="button button-secondary" type="button" onClick={reset}>
              <RefreshCw size={15} /> Retry
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
