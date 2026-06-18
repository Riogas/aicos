/** GET /api/studio/roster — roster de agentes (id, name, department) para la UI. */
import { loadRoster } from "@/lib/studio-prompt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEPT_COLORS: Record<string, string> = {
  exec: "#EAB308",
  it: "#3B82F6",
  marketing: "#EC4899",
  creative: "#A855F7",
  bi: "#10B981",
  research: "#F59E0B",
};

export async function GET() {
  const roster = loadRoster().map((a) => ({
    id: a.id,
    name: a.name,
    department: a.department,
    color: DEPT_COLORS[a.department] || "#71717a",
  }));
  return Response.json({ agents: roster });
}
