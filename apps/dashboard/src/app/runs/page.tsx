import { CircleCheck, Clock, DollarSign, TerminalSquare } from "lucide-react";
import { safeFetch, URLS } from "@/lib/fetcher";
import { Card, CardEmpty } from "@/components/Card";
import { MetricTile } from "@/components/MetricTile";
import { RunsTable, type RecentItem } from "./runs-table";

export const dynamic = "force-dynamic";

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

      <Card title="Today's runs" subtitle={`${count} entries · click para ver el resultado`}>
        {!recent.ok || count === 0 ? (
          <CardEmpty>{recent.error ?? "No runs today."}</CardEmpty>
        ) : (
          <RunsTable items={items} />
        )}
      </Card>
    </div>
  );
}
