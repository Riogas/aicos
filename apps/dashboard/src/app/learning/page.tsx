import { CircleCheck, CircleX, Crown, Sparkles, Trophy } from "lucide-react";
import { safeFetch, URLS } from "@/lib/fetcher";
import { Card, CardEmpty } from "@/components/Card";
import { Badge, StatusPill } from "@/components/StatusPill";
import { Bar } from "@/components/Bar";

export const dynamic = "force-dynamic";

interface Candidate {
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
}

interface BestForResult {
  taskType: string;
  candidates: Candidate[];
  best?: Candidate;
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
      <Card title="Learning unreachable">
        <CardEmpty>{summary.error}</CardEmpty>
      </Card>
    );
  }

  const entries = Object.entries(summary.data ?? {});
  const withData = entries.filter(([, r]) => r.totalSamples > 0);
  const withoutData = entries.filter(([, r]) => r.totalSamples === 0);

  return (
    <div className="space-y-8 animate-fade-in">
      <header>
        <h1 className="text-3xl font-semibold tracking-tightest text-fg">Learning</h1>
        <p className="mt-1 text-sm text-muted">
          Outcome-based provider ranking. Score = <code className="text-fg">successRate / (avgCost + ε)</code>.
          Higher = cheaper × more reliable.
        </p>
      </header>

      {withData.length > 0 && (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {withData.map(([taskType, r]) => (
            <BestForCard key={taskType} taskType={taskType} result={r} />
          ))}
        </section>
      )}

      {withoutData.length > 0 && (
        <Card title="Awaiting data" subtitle="need ≥ 3 samples each">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {withoutData.map(([taskType, r]) => (
              <div
                key={taskType}
                className="flex items-center justify-between rounded-md border border-border/40 bg-surface-2 px-3 py-2 text-xs"
              >
                <span className="font-mono text-muted">{taskType}</span>
                <span className="font-mono text-2xs tabular text-subtle">
                  {r.totalSamples} samples
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Recent outcomes" subtitle="bridge → learning (50 most recent today)">
        {!recent.ok || !recent.data?.items?.length ? (
          <CardEmpty>{recent.error ?? "no outcomes today"}</CardEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/60 text-left font-mono text-2xs uppercase tracking-tightest text-subtle">
                  <th className="py-2 pr-4 font-normal">time</th>
                  <th className="py-2 pr-4 font-normal">agent</th>
                  <th className="py-2 pr-4 font-normal">task</th>
                  <th className="py-2 pr-4 font-normal">cli/model</th>
                  <th className="py-2 pr-4 font-normal">provider</th>
                  <th className="py-2 pr-4 font-normal">status</th>
                  <th className="py-2 pr-4 text-right font-normal">duration</th>
                  <th className="py-2 pr-4 text-right font-normal">cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {recent.data.items.map((r, i) => (
                  <tr key={i} className="text-xs transition-colors hover:bg-surface-2">
                    <td className="py-2 pr-4 font-mono tabular text-subtle">
                      {(r.ts ?? "").slice(11, 19)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-fg">{r.agentRegistryId ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <Badge tone="neutral">{r.taskType}</Badge>
                    </td>
                    <td className="py-2 pr-4 font-mono text-muted">
                      {r.cli}/<span className="text-fg">{r.model.split("/").pop()}</span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-subtle">{r.provider}</td>
                    <td className="py-2 pr-4">
                      {r.success ? (
                        <CircleCheck className="h-3.5 w-3.5 text-success" strokeWidth={2.2} />
                      ) : (
                        <CircleX className="h-3.5 w-3.5 text-danger" strokeWidth={2.2} />
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono tabular text-muted">
                      {r.durationMs}ms
                    </td>
                    <td className="py-2 pr-4 text-right font-mono tabular text-muted">
                      ${r.costUsd.toFixed(4)}
                    </td>
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

function BestForCard({ taskType, result }: { taskType: string; result: BestForResult }) {
  const best = result.best;
  if (!best) return null;
  const successPct = Math.round(best.successRate * 100);
  const runnerUps = result.candidates.filter(
    (c) => !(c.cli === best.cli && c.model === best.model),
  );

  return (
    <Card
      title={taskType}
      subtitle={`${result.totalSamples} samples · ${result.source}`}
      action={
        <StatusPill tone="violet">
          <Sparkles className="h-3 w-3" />
          best
        </StatusPill>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-violet/30 bg-violet-soft p-4">
          <div className="mb-3 flex items-center gap-2">
            <Trophy className="h-4 w-4 text-violet" strokeWidth={2} />
            <div className="flex flex-col">
              <span className="font-mono text-sm font-semibold text-fg">
                {best.cli}/<span className="text-muted">{best.model.split("/").pop()}</span>
              </span>
              <span className="font-mono text-2xs text-subtle">via {best.provider}</span>
            </div>
            <div className="ml-auto text-right">
              <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">
                score
              </div>
              <div className="font-mono text-lg font-semibold tabular text-violet">
                {best.score.toFixed(0)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 font-mono text-xs">
            <Metric label="success" value={`${successPct}%`} tone={successPct >= 90 ? "ok" : "warn"} />
            <Metric label="avg cost" value={`$${best.avgCostUsd.toFixed(4)}`} />
            <Metric label="avg ms" value={Math.round(best.avgDurationMs).toString()} />
          </div>
          <div className="mt-3">
            <Bar percent={successPct} size="sm" />
          </div>
        </div>

        {runnerUps.length > 0 && (
          <div className="space-y-1.5">
            <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">
              runners-up
            </div>
            {runnerUps.slice(0, 4).map((c) => (
              <div
                key={`${c.cli}/${c.model}`}
                className="flex items-center justify-between rounded-md border border-border/40 bg-surface-2 px-3 py-1.5"
              >
                <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
                  <Crown className="h-3 w-3 text-subtle" strokeWidth={1.8} />
                  <span className="truncate text-muted">
                    {c.cli}/<span className="text-fg">{c.model.split("/").pop()}</span>
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2 font-mono text-2xs tabular text-subtle">
                  <span>{Math.round(c.successRate * 100)}%</span>
                  <span>${c.avgCostUsd.toFixed(4)}</span>
                  <span className="text-muted">score {c.score.toFixed(0)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  const valTone = tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-fg";
  return (
    <div className="flex flex-col">
      <span className="text-2xs uppercase tracking-tightest text-subtle">{label}</span>
      <span className={`tabular ${valTone}`}>{value}</span>
    </div>
  );
}
