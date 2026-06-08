import { ArrowRight, Clock, DollarSign, Gauge, Terminal } from "lucide-react";
import { safeFetch, URLS } from "@/lib/fetcher";
import { Card, CardEmpty } from "@/components/Card";
import { StatusPill, Badge } from "@/components/StatusPill";
import { Bar, Ring } from "@/components/Bar";
import { MetricTile } from "@/components/MetricTile";

export const dynamic = "force-dynamic";

interface QuotaSnapshot {
  criticalProvider: string;
  survivalActive: boolean;
  survivalModels: Array<{ cli: string; model: string; provider: string }>;
  providers: Record<
    string,
    {
      windowSec: number;
      usedCostUsd: number;
      requests: number;
      budget?: { maxCostUsd?: number; maxRequests?: number };
      available: boolean;
      unavailableReason?: string;
      windowResetAt?: string;
    }
  >;
  clis: Record<
    string,
    {
      windowSec: number;
      requests: number;
      budget?: { maxRequests: number };
      available: boolean;
      unavailableReason?: string;
      windowResetAt?: string;
    }
  >;
  generatedAt: string;
}

function pct(used: number, max: number | undefined): number {
  if (!max || max === 0) return 0;
  return Math.min(100, (used / max) * 100);
}

function timeUntil(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default async function QuotaPage() {
  const snap = await safeFetch<QuotaSnapshot>(URLS.quotaStatus());

  if (!snap.ok) {
    return (
      <Card title="Quota Manager unreachable">
        <CardEmpty>{snap.error}</CardEmpty>
      </Card>
    );
  }
  const d = snap.data!;

  const totalCost = Object.values(d.providers).reduce((s, p) => s + p.usedCostUsd, 0);
  const totalReqs = Object.values(d.providers).reduce((s, p) => s + p.requests, 0);
  const critical = d.providers[d.criticalProvider];
  const criticalCostPct = critical ? pct(critical.usedCostUsd, critical.budget?.maxCostUsd) : 0;

  return (
    <div className="space-y-8 animate-fade-in">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tightest text-fg">Quota</h1>
          <p className="mt-1 text-sm text-muted">
            Per-provider budgets. Bridge consults <code className="font-mono text-xs text-fg">/select</code>{" "}
            before every spawn and reports <code className="font-mono text-xs text-fg">/usage</code> after.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusPill tone={d.survivalActive ? "warn" : "ok"} pulse>
            survival: {d.survivalActive ? "ACTIVE" : "off"}
          </StatusPill>
          <span className="font-mono text-2xs tabular text-subtle">
            generated {d.generatedAt.slice(11, 19)}Z
          </span>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title={d.criticalProvider}
          subtitle="critical"
          className="lg:col-span-2"
          action={
            <StatusPill tone={critical?.available ? "ok" : "err"} pulse>
              {critical?.available ? "available" : "blocked"}
            </StatusPill>
          }
        >
          {critical ? (
            <div className="grid grid-cols-3 items-center gap-6">
              <div className="flex justify-center">
                <Ring
                  percent={criticalCostPct}
                  label={`${criticalCostPct.toFixed(0)}%`}
                  sublabel="of budget"
                  size={120}
                />
              </div>
              <div className="col-span-2 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">spent</div>
                    <div className="font-mono text-xl font-semibold tabular text-fg">
                      ${critical.usedCostUsd.toFixed(4)}
                    </div>
                    <div className="font-mono text-2xs tabular text-subtle">
                      / ${critical.budget?.maxCostUsd?.toFixed(2) ?? "∞"}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">
                      requests
                    </div>
                    <div className="font-mono text-xl font-semibold tabular text-fg">
                      {critical.requests}
                    </div>
                    <div className="font-mono text-2xs tabular text-subtle">
                      / {critical.budget?.maxRequests ?? "∞"}
                    </div>
                  </div>
                </div>
                {critical.unavailableReason && (
                  <div className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
                    ⚠ {critical.unavailableReason}
                  </div>
                )}
                <div className="flex items-center gap-1.5 font-mono text-2xs text-subtle">
                  <Clock className="h-3 w-3" />
                  window resets in <span className="text-muted">{timeUntil(critical.windowResetAt)}</span>
                </div>
              </div>
            </div>
          ) : (
            <CardEmpty>Critical provider not configured.</CardEmpty>
          )}
        </Card>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <MetricTile
            label="Total spend"
            value={`$${totalCost.toFixed(2)}`}
            hint="across all providers · 1h window"
            icon={DollarSign}
            tone={totalCost > 5 ? "warn" : "ok"}
          />
          <MetricTile
            label="Total requests"
            value={String(totalReqs)}
            hint="rolling 1h window"
            icon={Gauge}
            tone="accent"
          />
        </div>
      </section>

      <Card title="Providers" subtitle="ordered by budget pressure">
        <div className="space-y-4">
          {Object.entries(d.providers)
            .sort(
              ([, a], [, b]) =>
                Math.max(pct(b.usedCostUsd, b.budget?.maxCostUsd), pct(b.requests, b.budget?.maxRequests)) -
                Math.max(pct(a.usedCostUsd, a.budget?.maxCostUsd), pct(a.requests, a.budget?.maxRequests)),
            )
            .map(([name, p]) => {
              const costPct = pct(p.usedCostUsd, p.budget?.maxCostUsd);
              const reqPct = pct(p.requests, p.budget?.maxRequests);
              const worst = Math.max(costPct, reqPct);
              const isCritical = name === d.criticalProvider;
              return (
                <div
                  key={name}
                  className={`rounded-lg border bg-surface-2 px-4 py-3 transition-colors ${
                    !p.available
                      ? "border-danger/40"
                      : worst >= 70
                        ? "border-warning/30"
                        : "border-border/60"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          p.available ? "bg-success" : "bg-danger"
                        }`}
                      />
                      <span className="font-mono text-sm font-medium text-fg">{name}</span>
                      {isCritical && <Badge tone="accent">critical</Badge>}
                      {p.unavailableReason && (
                        <Badge tone="err">{p.unavailableReason.slice(0, 32)}</Badge>
                      )}
                    </div>
                    <div className="font-mono text-2xs tabular text-subtle">
                      resets {timeUntil(p.windowResetAt)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <div className="flex justify-between font-mono text-2xs tabular">
                        <span className="text-subtle">cost</span>
                        <span className="text-muted">
                          ${p.usedCostUsd.toFixed(4)}
                          {p.budget?.maxCostUsd != null && (
                            <span className="text-subtle"> / ${p.budget.maxCostUsd.toFixed(2)}</span>
                          )}
                        </span>
                      </div>
                      {p.budget?.maxCostUsd != null && <Bar percent={costPct} size="sm" />}
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between font-mono text-2xs tabular">
                        <span className="text-subtle">requests</span>
                        <span className="text-muted">
                          {p.requests}
                          {p.budget?.maxRequests != null && (
                            <span className="text-subtle"> / {p.budget.maxRequests}</span>
                          )}
                        </span>
                      </div>
                      {p.budget?.maxRequests != null && <Bar percent={reqPct} size="sm" />}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      </Card>

      <Card title="CLIs" subtitle="session-billed (claude-code / codex / antigravity)">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {Object.entries(d.clis).map(([name, c]) => {
            const reqPct = pct(c.requests, c.budget?.maxRequests);
            return (
              <div
                key={name}
                className={`rounded-lg border bg-surface-2 px-4 py-3 ${
                  !c.available
                    ? "border-danger/40"
                    : reqPct >= 70
                      ? "border-warning/30"
                      : "border-border/60"
                }`}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Terminal className="h-3.5 w-3.5 text-muted" strokeWidth={1.8} />
                  <span className="font-mono text-sm font-medium text-fg">{name}</span>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between font-mono text-2xs tabular">
                    <span className="text-subtle">messages</span>
                    <span className="text-muted">
                      {c.requests}
                      {c.budget?.maxRequests != null && (
                        <span className="text-subtle"> / {c.budget.maxRequests}</span>
                      )}
                    </span>
                  </div>
                  {c.budget?.maxRequests != null && <Bar percent={reqPct} size="sm" />}
                </div>
                <div className="mt-2 flex items-center gap-1.5 font-mono text-2xs text-subtle">
                  <Clock className="h-3 w-3" />
                  resets {timeUntil(c.windowResetAt)}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Survival fallback chain"
        subtitle={`activates when ${d.criticalProvider} is exhausted`}
      >
        {d.survivalModels.length === 0 ? (
          <CardEmpty>No survival models configured.</CardEmpty>
        ) : (
          <ol className="space-y-2">
            {d.survivalModels.map((m, i) => (
              <li
                key={`${m.cli}/${m.model}`}
                className="flex items-center gap-3 rounded-md border border-border/60 bg-surface-2 px-3 py-2"
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-violet-soft font-mono text-2xs font-semibold text-violet">
                  {i + 1}
                </span>
                <span className="font-mono text-sm text-fg">
                  {m.cli}/<span className="text-muted">{m.model}</span>
                </span>
                <ArrowRight className="h-3 w-3 text-subtle" />
                <Badge tone="neutral">{m.provider}</Badge>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
