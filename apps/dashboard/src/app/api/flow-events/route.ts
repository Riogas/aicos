/**
 * SSE proxy: forwards the bridge's /events stream to the browser.
 *
 * Why this proxy instead of connecting EventSource("http://localhost:7100/events")
 * directly: when the dashboard is served from a different origin than the
 * bridge (production, docker, behind a reverse proxy), CORS blocks the raw
 * cross-origin EventSource. Proxying via this same-origin Next route keeps
 * the dashboard origin-agnostic.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const BRIDGE = process.env.BRIDGE_SERVICE_URL || "http://localhost:7100";

export async function GET(req: Request) {
  // Cancel-aware upstream request.
  const ctrl = new AbortController();
  // Close upstream when the client disconnects.
  req.signal.addEventListener("abort", () => ctrl.abort());

  let upstream: Response;
  try {
    upstream = await fetch(`${BRIDGE}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (e) {
    return new NextResponse(`upstream unreachable: ${(e as Error).message}`, {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (!upstream.ok || !upstream.body) {
    return new NextResponse(`upstream returned ${upstream.status}`, {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Re-stream the upstream body with the right SSE headers.
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
