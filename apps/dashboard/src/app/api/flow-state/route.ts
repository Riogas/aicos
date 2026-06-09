/**
 * Aggregated live-state endpoint for the /flow viewer.
 * Polls quota + learning + tool-gateway audit + bridge health in parallel,
 * normalizes into a flat shape consumed by the React Flow client.
 *
 * v2 changes:
 *   - Multiple concurrent in-flight runs (not just [0]).
 *   - Pulls ALL in_progress issues directly from Paperclip so we see runs
 *     dispatched via process adapter (the HTTP-only in-flight tracker misses
 *     those).
 *   - Tree view: when issues share a parent_id, we group them and emit
 *     parent/children edges for the dashboard to render the subtask tree.
 *   - triggeredBy heuristic: if the assignee is Hermes (CEO) AND the ticket
 *     was created in the last 5 min → "telegram"; otherwise "paperclip".
 *   - Per-service active signals tied to real recent activity:
 *       quota   = any liveRun in last 30s (we DO call /select per attempt)
 *       memory  = any liveRun in last 30s (we DO call qdrant retrieveAllScopes per run)
 *       learning = recent /recent items in last 60s (each run posts /usage at end)
 *       gateway = recentToolCalls.length > 0
 *       policy  = false (no /audit/recent endpoint yet)
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const T = 2000;
const fetchSafe = async <T,>(url: string, headers?: Record<string, string>): Promise<T | null> => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), T);
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
};

interface QuotaSnapshot {
  criticalProvider: string;
  survivalActive: boolean;
  providers: Record<
    string,
    { usedCostUsd: number; requests: number; available: boolean; budget?: { maxCostUsd?: number; maxRequests?: number } }
  >;
  clis: Record<string, { requests: number; available: boolean }>;
}

interface RecentRun {
  provider: string;
  cli: string;
  model: string;
  taskType: string;
  success: boolean;
  durationMs: number;
  costUsd: number;
  agentRegistryId?: string;
  ticketId?: string;
  ts?: string;
}

interface AuditEntry {
  ts: string;
  tool: string;
  action: string;
  actor: { id: string };
  decision: string;
}

interface BridgeHealth {
  paperclip?: string;
  quota?: string;
  learning?: string;
  registry?: { resolvableAgents?: number };
}

interface PaperclipIssue {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  parentId?: string | null;
  createdByAgentId?: string | null;
  startedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  blockedBy?: Array<{ id: string; identifier?: string | null; status?: string }>;
}

// (HERMES_AGENT_ID and TELEGRAM_FRESHNESS_MS heuristic removed — we now derive
// triggeredBy from the parent issue's "[telegram]" title prefix, which the
// orchestrator sets when called with triggeredBy="telegram".)

// Simple cli→provider mapping (mirror of bridge provider-map.ts)
function inferProvider(cli: string | undefined, model: string | undefined): string {
  if (!cli) return "unknown";
  switch (cli) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "agy":
      return "google";
    case "opencode": {
      if (!model) return "unknown";
      const m = model.toLowerCase();
      if (m.includes("free")) return "opencode-free";
      if (m.startsWith("openai/") || m.includes("gpt-")) return "openai";
      if (m.startsWith("anthropic/") || m.includes("claude")) return "anthropic";
      if (m.startsWith("google/") || m.startsWith("gemini")) return "google";
      if (m.startsWith("moonshotai/") || m.includes("kimi")) return "moonshot";
      if (m.startsWith("xiaomi/") || m.includes("mimo")) return "xiaomi";
      return "unknown";
    }
    case "hermes":
      if (!model) return "openai";
      const slash = model.indexOf("/");
      return slash > 0 ? model.slice(0, slash).toLowerCase() : "openai";
    default:
      return "unknown";
  }
}

interface AgentRosterEntry {
  id: string;
  paperclipAgentId?: string;
  name: string;
  preferredCli?: string;
  preferredModel?: string;
}

// Resolved once per request from the bridge registry. Used to map
// assigneeAgentId (Paperclip UUID) → registryId (it-analyst etc.) AND to
// know which CLI each agent prefers (so the dashboard can highlight the
// preferred edge while a run is still warming up and the learning record
// hasn't been written yet).
async function getAgentRoster(bridgeUrl: string): Promise<Map<string, AgentRosterEntry>> {
  type Resp = {
    agents?: Array<{
      id?: string;
      paperclipAgentId?: string;
      name?: string;
      preferredModel?: { cli?: string; model?: string };
    }>;
  };
  const r = await fetchSafe<Resp>(`${bridgeUrl}/admin/registry`);
  const map = new Map<string, AgentRosterEntry>();
  for (const a of r?.agents ?? []) {
    if (!a.paperclipAgentId || !a.id) continue;
    map.set(a.paperclipAgentId, {
      id: a.id,
      paperclipAgentId: a.paperclipAgentId,
      name: a.name ?? a.id,
      preferredCli: a.preferredModel?.cli,
      preferredModel: a.preferredModel?.model,
    });
  }
  return map;
}

export async function GET() {
  const QUOTA = process.env.QUOTA_SERVICE_URL || "http://localhost:7001";
  const LEARNING = process.env.LEARNING_SERVICE_URL || "http://localhost:7003";
  const BRIDGE = process.env.BRIDGE_SERVICE_URL || "http://localhost:7100";
  const GATEWAY = process.env.GATEWAY_SERVICE_URL || "http://localhost:7004";
  const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
  const PAPERCLIP_KEY = process.env.PAPERCLIP_API_KEY;
  const COMPANY_ID = process.env.AICOS_COMPANY_ID;

  // Paperclip auth header — passed only when configured
  const pcHeaders = PAPERCLIP_KEY ? { Authorization: `Bearer ${PAPERCLIP_KEY}` } : undefined;

  const paperclipIssuesUrl =
    PAPERCLIP_KEY && COMPANY_ID
      ? `${PAPERCLIP}/api/companies/${COMPANY_ID}/issues?status=in_progress&includeBlockedBy=true`
      : null;

  const [quota, recent, bridge, audit, paperclipInProgress, roster] = await Promise.all([
    fetchSafe<QuotaSnapshot>(`${QUOTA}/status`),
    fetchSafe<{ items: RecentRun[] }>(`${LEARNING}/recent`),
    fetchSafe<BridgeHealth>(`${BRIDGE}/health`),
    fetchSafe<{ items: AuditEntry[] }>(`${GATEWAY}/audit/recent`),
    paperclipIssuesUrl ? fetchSafe<{ items: PaperclipIssue[] } | PaperclipIssue[]>(paperclipIssuesUrl, pcHeaders) : Promise.resolve(null),
    getAgentRoster(BRIDGE),
  ]);

  const now = Date.now();
  const items = (recent?.items ?? []).slice(0, 20);

  // Normalize Paperclip in-progress list (it may come as a bare array or { items })
  const pcInFlight = Array.isArray(paperclipInProgress)
    ? paperclipInProgress
    : paperclipInProgress?.items ?? [];

  // Cross-reference each Paperclip in_progress issue with the most recent
  // learning record for the same ticket to find which CLI / model is running.
  // This way the dashboard can light up the correct CLI box per worker.
  function findRecentForTicket(ticketIdentifier: string | null | undefined): RecentRun | undefined {
    if (!ticketIdentifier) return undefined;
    // Learning stores ticketId as the identifier (RIO-XX) when available.
    return items.find((r) => r.ticketId === ticketIdentifier);
  }

  type LiveRun = {
    persona: string;
    personaName: string;
    cli: string;
    model: string;
    provider: string;
    ticketId: string | null;
    ticketIdentifier: string | null;
    parentIssueId: string | null;
    triggeredBy: "telegram" | "paperclip" | "manual";
    startedAt: string;
    ageMs: number;
    success?: boolean;
  };

  const liveRuns: LiveRun[] = pcInFlight.map((iss) => {
    const personaEntry = iss.assigneeAgentId ? roster.get(iss.assigneeAgentId) : undefined;
    const recentForTicket = findRecentForTicket(iss.identifier ?? null);
    // If we haven't seen a learning record yet (run just started, hasn't
    // emitted recordOutcome), fall back to the persona's PREFERRED CLI/model
    // from the registry. The dashboard can then light up the canonical edge
    // immediately instead of waiting ~30s for the first run to complete.
    const cli = recentForTicket?.cli ?? personaEntry?.preferredCli ?? "?";
    const model = recentForTicket?.model ?? personaEntry?.preferredModel ?? "?";
    const provider = recentForTicket?.provider ?? inferProvider(cli, model);

    // triggeredBy heuristic: an in-flight ticket is "telegram" only if
    // either the ticket itself OR its parent has the [telegram] prefix in
    // its title (set by the orchestrator when triggeredBy=telegram). This
    // avoids false-positives when the orchestrator creates tickets using
    // the Hermes API key (createdByAgentId=Hermes is NOT a reliable signal).
    let triggeredBy: LiveRun["triggeredBy"] = "paperclip";
    if (iss.title?.startsWith("[telegram]")) {
      triggeredBy = "telegram";
    }

    return {
      persona: personaEntry?.id ?? "unknown",
      personaName: personaEntry?.name ?? iss.assigneeAgentId ?? "unknown",
      cli,
      model,
      provider,
      ticketId: iss.id,
      ticketIdentifier: iss.identifier ?? null,
      parentIssueId: iss.parentId ?? null,
      triggeredBy,
      startedAt: iss.startedAt ?? iss.updatedAt ?? iss.createdAt ?? new Date(now).toISOString(),
      ageMs: now - Date.parse(iss.startedAt ?? iss.updatedAt ?? iss.createdAt ?? new Date(now).toISOString()),
      success: undefined,
    };
  });

  // Build subtask tree from the in_progress set: group by parentIssueId.
  // For each parent, include its children's identifier + assignee + status.
  // Also pull parent info if any liveRun has a parentIssueId set.
  const parentIds = new Set<string>();
  for (const r of liveRuns) {
    if (r.parentIssueId) parentIds.add(r.parentIssueId);
  }
  let parents: PaperclipIssue[] = [];
  if (parentIds.size > 0 && pcHeaders && COMPANY_ID) {
    // Paperclip doesn't have a "by ids" bulk endpoint — get each parent
    parents = (
      await Promise.all(
        Array.from(parentIds).map((pid) =>
          fetchSafe<PaperclipIssue>(`${PAPERCLIP}/api/issues/${pid}`, pcHeaders),
        ),
      )
    ).filter((p): p is PaperclipIssue => p !== null);
  }

  // Propagate [telegram] tag from parent down to children: if the parent
  // title starts with "[telegram]" then every subtask under it is also
  // considered telegram-originated for operator-light purposes.
  const parentById = new Map(parents.map((p) => [p.id, p]));
  for (const r of liveRuns) {
    if (r.triggeredBy === "telegram") continue;
    const parent = r.parentIssueId ? parentById.get(r.parentIssueId) : undefined;
    if (parent?.title?.startsWith("[telegram]")) {
      r.triggeredBy = "telegram";
    }
  }

  // Aggregate active sets used by the UI to glow nodes/edges
  const activeWorkers = new Set<string>();
  const activeClis = new Set<string>();
  const activeProviders = new Set<string>();
  for (const r of liveRuns) {
    if (r.persona !== "unknown") activeWorkers.add(r.persona);
    if (r.cli && r.cli !== "?") activeClis.add(r.cli);
    if (r.provider && r.provider !== "unknown") activeProviders.add(r.provider);
  }
  // Plus anything that finished in the last 30s (so the trail is visible)
  const completionWindowMs = 30_000;
  for (const r of items) {
    if (!r.ts) continue;
    if (now - Date.parse(r.ts) > completionWindowMs) continue;
    if (r.agentRegistryId) activeWorkers.add(r.agentRegistryId);
    if (r.cli) activeClis.add(r.cli);
    if (r.provider) activeProviders.add(r.provider);
  }

  // Per-service activation: each one keys off a real signal
  const activeServices = {
    quota: liveRuns.length > 0, // bridge calls /select on every run
    memory: liveRuns.length > 0, // bridge calls qdrant retrieveAllScopes on every run
    learning:
      items.some((r) => r.ts && now - Date.parse(r.ts) <= completionWindowMs) || liveRuns.length > 0,
    gateway: (audit?.items?.length ?? 0) > 0,
    policy: false, // no /audit/recent on policy-engine yet
  };

  // Operator distinction: light up only if at least one live run is telegram-originated
  const operatorActive = liveRuns.some((r) => r.triggeredBy === "telegram");
  // paperclip is "live" any time tickets are running, regardless of origin
  const paperclipActive = liveRuns.length > 0;

  const recentAuditCalls = (audit?.items ?? []).slice(0, 6);

  // Back-compat: surface a single liveRun (most-recent-started) so legacy
  // dashboard consumers don't break
  const primaryLive = liveRuns.length > 0 ? liveRuns[0]! : null;

  return NextResponse.json({
    ts: new Date(now).toISOString(),
    bridge: {
      healthy: Boolean(bridge),
      paperclip: bridge?.paperclip ?? "missing",
      quota: bridge?.quota ?? "missing",
      learning: bridge?.learning ?? "missing",
      agentCount: bridge?.registry?.resolvableAgents ?? 0,
    },
    quota: quota
      ? {
          critical: quota.criticalProvider,
          survival: quota.survivalActive,
          providers: Object.fromEntries(
            Object.entries(quota.providers).map(([k, v]) => {
              // The bar should show the MAX of cost-saturation and request-
              // saturation, not just cost. Reason: codex (openai) and agy
              // (google) CLIs do NOT emit cost data, so usedCostUsd stays at
              // $0 and the bar would always read 0% even after dozens of
              // runs. Using max(cost%, requests%) makes the bar reflect real
              // activity regardless of whether the CLI reports cost.
              const costPct = v.budget?.maxCostUsd
                ? (v.usedCostUsd / v.budget.maxCostUsd) * 100
                : 0;
              const reqPct = v.budget?.maxRequests
                ? (v.requests / v.budget.maxRequests) * 100
                : 0;
              const pct = Math.min(100, Math.max(costPct, reqPct));
              return [
                k,
                {
                  usedCostUsd: v.usedCostUsd,
                  requests: v.requests,
                  available: v.available,
                  pct,
                },
              ];
            }),
          ),
          clis: Object.fromEntries(
            Object.entries(quota.clis).map(([k, v]) => [
              k,
              { requests: v.requests, available: v.available },
            ]),
          ),
        }
      : null,
    // New: multiple concurrent runs
    liveRuns: liveRuns.map((r) => ({
      persona: r.persona,
      personaName: r.personaName,
      cli: r.cli,
      model: r.model,
      provider: r.provider,
      ticketId: r.ticketId,
      ticketIdentifier: r.ticketIdentifier,
      parentIssueId: r.parentIssueId,
      triggeredBy: r.triggeredBy,
      startedAt: r.startedAt,
      ageMs: r.ageMs,
    })),
    // Back-compat: single primary live run for legacy code paths
    liveRun: primaryLive
      ? {
          persona: primaryLive.persona,
          cli: primaryLive.cli,
          model: primaryLive.model,
          provider: primaryLive.provider,
          taskType: "other",
          success: true,
          durationMs: primaryLive.ageMs,
          costUsd: 0,
          ticketId: primaryLive.ticketIdentifier,
          ts: primaryLive.startedAt,
        }
      : null,
    // Subtask tree: each parent + its children identifiers/status from
    // Paperclip's blockedBy graph
    tree: parents.map((p) => ({
      id: p.id,
      identifier: p.identifier ?? null,
      title: p.title,
      status: p.status,
      // children = liveRuns that point to this parent
      childrenLive: liveRuns.filter((r) => r.parentIssueId === p.id).map((r) => ({
        persona: r.persona,
        identifier: r.ticketIdentifier,
        cli: r.cli,
      })),
    })),
    recent: items.map((r) => ({
      persona: r.agentRegistryId ?? "?",
      cli: r.cli,
      model: r.model,
      provider: r.provider,
      success: r.success,
      durationMs: r.durationMs,
      costUsd: r.costUsd,
      ts: r.ts ?? "",
    })),
    activeWorkers: Array.from(activeWorkers),
    activeClis: Array.from(activeClis),
    activeProviders: Array.from(activeProviders),
    activeServices,
    operatorActive,
    paperclipActive,
    recentToolCalls: recentAuditCalls.map((a) => ({
      ts: a.ts,
      tool: a.tool,
      action: a.action,
      actor: a.actor.id,
      decision: a.decision,
    })),
    totals: {
      totalRunsToday: items.length,
      successRate:
        items.length > 0
          ? Math.round((items.filter((r) => r.success).length / items.length) * 100)
          : 0,
      totalCostToday: items.reduce((s, r) => s + r.costUsd, 0),
      // Number of concurrent agents working right now
      activeAgentCount: activeWorkers.size,
    },
  });
}
