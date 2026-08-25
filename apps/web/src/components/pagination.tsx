import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { NextSearchParams } from "../lib/query";
import { withQuery } from "../lib/query";
import type { Pagination } from "../lib/types";

export function PaginationControls({
  pathname,
  params,
  pagination,
  itemCount,
}: {
  pathname: string;
  params: NextSearchParams;
  pagination: Pagination;
  itemCount: number;
}): React.JSX.Element | null {
  if (!pagination.nextCursor && !pagination.previousCursor && pagination.total === undefined)
    return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <p>
        Showing {itemCount} {itemCount === 1 ? "item" : "items"}
        {pagination.total !== undefined ? ` of ${pagination.total}` : ""}
      </p>
      <div>
        {pagination.previousCursor ? (
          <Link
            className="button button-secondary"
            href={withQuery(pathname, params, { cursor: pagination.previousCursor })}
          >
            <ChevronLeft size={15} aria-hidden="true" /> Previous
          </Link>
        ) : (
          <span className="button button-secondary disabled" aria-disabled="true">
            <ChevronLeft size={15} /> Previous
          </span>
        )}
        {pagination.nextCursor ? (
          <Link
            className="button button-secondary"
            href={withQuery(pathname, params, { cursor: pagination.nextCursor })}
          >
            Next <ChevronRight size={15} aria-hidden="true" />
          </Link>
        ) : (
          <span className="button button-secondary disabled" aria-disabled="true">
            Next <ChevronRight size={15} />
          </span>
        )}
      </div>
    </nav>
  );
}
