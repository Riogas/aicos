/**
 * GET /api/control/state — estado para el Centro de Control:
 *   - issues que necesitan atención (blocked) + en ejecución (in_progress)
 *   - estado del "pánico" (cuántos agentes pausados)
 *   - runs en vuelo (bridge)
 */
import { issuesByStatus, listAgents, bridge } from "@/lib/paperclip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [blocked, inProgress, agents, inflight] = await Promise.all([
    issuesByStatus("blocked"),
    issuesByStatus("in_progress"),
    listAgents(),
    bridge("GET", "/in-flight").then((r) => r.data).catch(() => null),
  ]);

  const nameById: Record<string, string> = {};
  for (const a of agents) nameById[a.id] = a.name;

  const paused = agents.filter((a) => (a.status === "paused") || a.pausedAt || a.paused_at);
  const slim = (i: any) => ({
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    status: i.status,
    assignee: i.assigneeAgentId ? (nameById[i.assigneeAgentId] || "—") : "—",
    updatedAt: i.updatedAt,
  });

  return Response.json({
    blocked: blocked.map(slim),
    inProgress: inProgress.map(slim),
    panic: {
      active: agents.length > 0 && paused.length >= agents.length,
      pausedCount: paused.length,
      totalAgents: agents.length,
    },
    inflight: inflight?.items?.length ?? 0,
  });
}
