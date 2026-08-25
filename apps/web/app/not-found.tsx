import Link from "next/link";

export default function NotFound(): React.JSX.Element {
  return (
    <div className="not-found">
      <div>
        <strong>404 / NOT FOUND</strong>
        <h1>That ArcDB record does not exist</h1>
        <p>It may have been removed, belong to another project, or the URL may be incomplete.</p>
        <Link className="button button-primary" href="/overview">
          Return to overview
        </Link>
      </div>
    </div>
  );
}
