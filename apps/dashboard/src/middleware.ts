/**
 * Single-token auth for the AICOS dashboard.
 *
 * When the env var AICOS_DASHBOARD_TOKEN is set, every page and every
 * /api/* request must present that exact token in either:
 *   - cookie aicos_token=<token>, OR
 *   - Authorization: Bearer <token> header.
 *
 * When AICOS_DASHBOARD_TOKEN is NOT set, auth is bypassed (dev mode) so
 * local development isn't blocked.
 *
 * Pages that need to render even without a token: /login.
 * API routes that need to render even without a token: none right now.
 *
 * Why a single shared token instead of users + sessions: the dashboard is
 * read-only operator surface — typically one human watching live state,
 * possibly two. A real RBAC system here would be massive over-engineering.
 * If we later need per-user audit, we add a /audit route that captures
 * who-saw-what; the token model stays.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "aicos_token";
const TOKEN = process.env.AICOS_DASHBOARD_TOKEN;

function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.cookies.get(COOKIE_NAME);
  if (cookie?.value) return cookie.value;
  return null;
}

export function middleware(req: NextRequest) {
  // Dev mode: no token configured → allow all.
  if (!TOKEN) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // Public paths: /login itself and the API that backs it.
  if (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const presented = extractToken(req);
  if (presented === TOKEN) return NextResponse.next();

  // API: 401 with a clear body. Pages: redirect to /login.
  if (pathname.startsWith("/api/")) {
    return new NextResponse(
      JSON.stringify({ error: "unauthorized — provide AICOS_DASHBOARD_TOKEN" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on every path EXCEPT static assets (handled inside middleware too as a
  // belt-and-braces measure, but matcher keeps the middleware off the hot path
  // for image/css requests).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
