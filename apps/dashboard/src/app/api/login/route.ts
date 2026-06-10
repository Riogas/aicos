/**
 * POST /api/login { token } — if the token matches AICOS_DASHBOARD_TOKEN,
 * sets the aicos_token cookie and returns 200. Otherwise 401.
 *
 * The middleware bypasses /api/login for unauth requests (it's in the
 * `pathname === "/login"`-equivalent allow list — see middleware.ts).
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "aicos_token";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 14; // 14 days

export async function POST(req: Request) {
  const expected = process.env.AICOS_DASHBOARD_TOKEN;
  if (!expected) {
    // Dev mode — auth is disabled altogether, no need to set a cookie.
    return NextResponse.json({ ok: true, devMode: true });
  }
  let body: { token?: string } = {};
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (body.token !== expected) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, body.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE_S,
    path: "/",
  });
  return res;
}
