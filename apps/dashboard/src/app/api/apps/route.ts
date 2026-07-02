/** GET /api/apps → { apps } (proxy al bridge /apps) */
import { bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const { data } = await bridge("GET", "/apps").catch(() => ({ code: 0, data: null }));
  return Response.json(data ?? { apps: [] });
}
