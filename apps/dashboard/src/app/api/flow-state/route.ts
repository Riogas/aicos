/**
 * Aggregated live-state endpoint for the /flow viewer.
 * Polls quota + learning + tool-gateway audit + bridge health in parallel,
 * normalizes into a flat shape consumed by the React Flow client.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const T = 2000;
const fetchSafe = async <T,>(url: string): Promise<T | null> => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), T);
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
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

export async function GET() {
  const QUOTA = process.env.QUOTA_SERVICE_URL || "http://localhost:7001";
  const LEARNING = process.env.LEARNING_SERVICE_URL || "http://localhost:7003";
  const BRIDGE = process.env.BRIDGE_SERVICE_URL || "http://localhost:7100";
  const GATEWAY = process.env.GATEWAY_SERVICE_URL || "http://localhost:7004";

  const [quota, recent, bridge, audit] = await Promise.all([
    fetchSafe<QuotaSnapshot>(`${QUOTA}/status`),
    fetchSafe<{ items: RecentRun[] }>(`${LEARNING}/recent`),
    fetchSafe<BridgeHealth>(`${BRIDGE}/health`),
    fetchSafe<{ items: AuditEntry[] }>(`${GATEWAY}/audit/recent`),
  ]);

  const now = Date.now();
  const items = (recent?.items ?? []).slice(0, 12);

  // Detect "currently running" — the most recent run within last 90s
  const liveRun = items.find((r) => {
    if (!r.ts) return false;
    const age = now - new Date(r.ts).getTime();
    return age >= 0 && age < 90_000;
  });

  // Which workers / clis / providers have been ACTIVE recently (last 60s)
  const activeWindow = 60_000;
  const activeWorkers = new Set<string>();
  const activeClis = new Set<string>();
  const activeProviders = new Set<string>();
  for (const r of items) {
    if (!r.ts) continue;
    if (now - new Date(r.ts).getTime() > activeWindow) continue;
    if (r.agentRegistryId) activeWorkers.add(r.agentRegistryId);
    if (r.cli) activeClis.add(r.cli);
    if (r.provider) activeProviders.add(r.provider);
  }

  const recentAuditCalls = (audit?.items ?? []).slice(0, 6);

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
            Object.entries(quota.providers).map(([k, v]) => [
              k,
              {
                usedCostUsd: v.usedCostUsd,
                requests: v.requests,
                available: v.available,
                pct: v.budget?.maxCostUsd
                  ? Math.min(100, (v.usedCostUsd / v.budget.maxCostUsd) * 100)
                  : v.budget?.maxRequests
                    ? Math.min(100, (v.requests / v.budget.maxRequests) * 100)
                    : 0,
              },
            ]),
          ),
          clis: Object.fromEntries(
            Object.entries(quota.clis).map(([k, v]) => [
              k,
              { requests: v.requests, available: v.available },
            ]),
          ),
        }
      : null,
    liveRun: liveRun
      ? {
          persona: liveRun.agentRegistryId ?? "unknown",
          cli: liveRun.cli,
          model: liveRun.model,
          provider: liveRun.provider,
          taskType: liveRun.taskType,
          success: liveRun.success,
          durationMs: liveRun.durationMs,
          costUsd: liveRun.costUsd,
          ticketId: liveRun.ticketId ?? null,
          ts: liveRun.ts,
        }
      : null,
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
    },
  });
}
