import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { authorizeConsoleRequest } from "./src/lib/console-auth";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export function proxy(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/health/live" ||
    pathname === "/favicon.ico" ||
    pathname === "/_next/image" ||
    pathname.startsWith("/_next/static/")
  ) {
    return NextResponse.next();
  }
  const decision = authorizeConsoleRequest(request.headers.get("authorization"));
  if (decision.kind === "ALLOW") return NextResponse.next();
  if (decision.kind === "MISCONFIGURED") {
    return new NextResponse("ArcDB console authentication is not configured.\n", {
      status: 503,
      headers: responseHeaders,
    });
  }
  return new NextResponse("Authentication required.\n", {
    status: 401,
    headers: {
      ...responseHeaders,
      "WWW-Authenticate": 'Basic realm="ArcDB Console", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: ["/:path*"],
};
