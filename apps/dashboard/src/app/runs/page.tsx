import { CircleCheck, CircleX, Clock, DollarSign, TerminalSquare } from "lucide-react";
import { safeFetch, URLS } from "@/lib/fetcher";
import { Card, CardEmpty } from "@/components/Card";
import { Badge } from "@/components/StatusPill";
import { MetricTile } from "@/components/MetricTile";

export const dynamic = "force-dynamic";

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

export default async function RunsPage() {
  const recent = await safeFetch<{ items: RecentItem[] }>(URLS.learningRecent());
  const items = recent.ok ? recent.data?.items ?? [] : [];

  const count = items.length;
  const successCount = items.filter((r) => r.success).length;
  const successPct = count ? Math.round((successCount / count) * 100) : 0;
  const totalCost = items.reduce((s, r) => s + r.costUsd, 0);
  const avgMs = count ? Math.round(items.reduce((s, r) => s + r.durationMs, 0) / count) : 0;

  return (
    <div className="space-y-8 animate-fade-in">
      <header>
        <h1 className="text-3xl font-semibold tracking-tightest text-fg">Runs</h1>
        <p className="mt-1 text-sm text-muted">
          50 most recent agent runs today. Sourced from learning service audit log.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          label="Runs"
          value={String(count)}
          hint="today"
          icon={TerminalSquare}
        />
        <MetricTile
          label="Success"
          value={`${successPct}`}
          unit="%"
          hint={`${successCount} ok / ${count - successCount} fail`}
          icon={CircleCheck}
          tone={successPct >= 95 ? "ok" : successPct >= 80 ? "warn" : "err"}
        />
        <MetricTile
          label="Spend (today)"
          value={`$${totalCost.toFixed(2)}`}
          hint="sum of all runs"
          icon={DollarSign}
        />
        <MetricTile
          label="Avg duration"
          value={`${avgMs}`}
          unit="ms"
          hint="across all runs"
          icon={Clock}
        />
      </section>

      <Card title="Today's runs" subtitle={`${count} entries`}>
        {!recent.ok || count === 0 ? (
          <CardEmpty>{recent.error ?? "No runs today."}</CardEmpty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/60 text-left font-mono text-2xs uppercase tracking-tightest text-subtle">
                  <th className="py-2 pr-3 font-normal">time</th>
                  <th className="py-2 pr-3 font-normal">agent</th>
                  <th className="py-2 pr-3 font-normal">ticket</th>
                  <th className="py-2 pr-3 font-normal">task</th>
                  <th className="py-2 pr-3 font-normal">cli/model</th>
                  <th className="py-2 pr-3 font-normal">provider</th>
                  <th className="py-2 pr-3 font-normal">status</th>
                  <th className="py-2 pr-3 text-right font-normal">ms</th>
                  <th className="py-2 pr-3 text-right font-normal">cost</th>
                  <th className="py-2 pr-3 font-normal">error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {items.map((r, i) => (
                  <tr key={i} className="text-xs transition-colors hover:bg-surface-2">
                    <td className="py-2 pr-3 font-mono tabular text-subtle">
                      {(r.ts ?? "").slice(11, 19)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-fg">{r.agentRegistryId ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono text-muted">{r.ticketId ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <Badge tone="neutral">{r.taskType}</Badge>
                    </td>
                    <td className="py-2 pr-3 font-mono text-muted">
                      {r.cli}/<span className="text-fg">{r.model.split("/").pop()}</span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-subtle">{r.provider}</td>
                    <td className="py-2 pr-3">
                      {r.success ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <CircleCheck className="h-3.5 w-3.5" strokeWidth={2.2} />
                          ok
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-danger">
                          <CircleX className="h-3.5 w-3.5" strokeWidth={2.2} />
                          fail
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular text-muted">
                      {r.durationMs}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular text-muted">
                      ${r.costUsd.toFixed(4)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-2xs text-danger">
                      {r.failureReason ?? ""}
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
