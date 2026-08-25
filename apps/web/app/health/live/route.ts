export function GET(): Response {
  return Response.json(
    { status: "ok", service: "arcdb-web" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
