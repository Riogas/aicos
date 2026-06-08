import { safeFetch, URLS } from "@/lib/fetcher";
import { Card } from "@/components/Card";

export const dynamic = "force-dynamic";

interface BestForResult {
  taskType: string;
  candidates: Array<{
    provider: string;
    cli: string;
    model: string;
    total: number;
    success: number;
    successRate: number;
    avgDurationMs: number;
    avgCostUsd: number;
    score: number;
    lastRunAt?: string;
  }>;
  best?: BestForResult["candidates"][number];
  totalSamples: number;
  source: "data" | "default";
}

interface RecentItem {
  provider: string;
  cli: string;
  model: string;
  taskType: string;
  success: boolean;
  durationMs: number;
  costUsd: number;
  agentRegistryId?: string;
  ticketId?: string;
  failureReason?: string;
  ts?: string;
}

export default async function LearningPage() {
  const [summary, recent] = await Promise.all([
    safeFetch<Record<string, BestForResult>>(URLS.learningSummary()),
    safeFetch<{ items: RecentItem[] }>(URLS.learningRecent()),
  ]);

  if (!summary.ok) {
    return (
      <Card title="Learning unreachable" accent="err">
        {summary.error}
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Learning</h1>
        <p className="mt-1 text-sm text-muted">Outcome-based provider ranking · best-for per task type</p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Object.entries(summary.data ?? {}).map(([taskType, r]) => (
          <Card
            key={taskType}
            title={taskType}
            subtitle={`${r.totalSamples} samples · ${r.source}`}
            accent={r.totalSamples > 0 ? "ok" : undefined}
          >
            {r.best ? (
              <>
                <div className="font-mono text-xs">
                  <div className="text-accent">{r.best.cli}/{r.best.model}</div>
                  <div className="text-muted">provider={r.best.provider}</div>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-neutral-300">
                    <span>success: {(r.best.successRate * 100).toFixed(0)}%</span>
                    <span>avg cost: ${r.best.avgCostUsd.toFixed(4)}</span>
                    <span>avg ms: {Math.round(r.best.avgDurationMs)}</span>
                    <span>score: {r.best.score.toFixed(1)}</span>
                  </div>
                </div>
                {r.candidates.length > 1 && (
                  <div className="mt-3 border-t border-border pt-2 text-xs">
                    <div className="mb-1 text-muted">other candidates:</div>
                    <ul className="space-y-0.5 font-mono">
                      {r.candidates.slice(1).map((c) => (
                        <li key={`${c.cli}/${c.model}`} className="flex justify-between">
                          <span className="text-neutral-400">{c.cli}/{c.model}</span>
                          <span className="text-muted">score={c.score.toFixed(1)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <span className="text-muted">no data yet (need ≥ 3 samples)</span>
            )}
          </Card>
        ))}
      </div>

      <Card title="Recent outcomes (last 50 today)" subtitle="bridge → learning">
        {!recent.ok || !recent.data?.items?.length ? (
          <span className="text-muted">{recent.error ?? "no outcomes today"}</span>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1 pr-3">ts</th>
                  <th className="py-1 pr-3">agent</th>
                  <th className="py-1 pr-3">task</th>
                  <th className="py-1 pr-3">cli/model</th>
                  <th className="py-1 pr-3">ok</th>
                  <th className="py-1 pr-3">ms</th>
                  <th className="py-1 pr-3">cost</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.items.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1 pr-3 text-muted">{(r.ts ?? "").slice(11, 19)}</td>
                    <td className="py-1 pr-3 text-neutral-300">{r.agentRegistryId ?? "-"}</td>
                    <td className="py-1 pr-3 text-neutral-400">{r.taskType}</td>
                    <td className="py-1 pr-3">{r.cli}/{r.model}</td>
                    <td className="py-1 pr-3">
                      {r.success ? <span className="text-success">✓</span> : <span className="text-danger">✗</span>}
                    </td>
                    <td className="py-1 pr-3 text-neutral-400">{r.durationMs}</td>
                    <td className="py-1 pr-3 text-neutral-400">${r.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
