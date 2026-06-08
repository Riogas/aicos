import { safeFetch, URLS } from "@/lib/fetcher";
import { Card } from "@/components/Card";

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

function bar(percent: number) {
  const fill = percent >= 90 ? "bg-danger" : percent >= 70 ? "bg-warn" : "bg-accent";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
      <div className={`h-full ${fill}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

export default async function QuotaPage() {
  const snap = await safeFetch<QuotaSnapshot>(URLS.quotaStatus());

  if (!snap.ok) {
    return (
      <Card title="Quota Manager unreachable" accent="err">
        {snap.error}
      </Card>
    );
  }
  const d = snap.data!;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Quota</h1>
          <p className="mt-1 text-sm text-muted">Per-provider budgets · live · generated {d.generatedAt.slice(11, 19)}</p>
        </div>
        <div
          className={`rounded-md border px-3 py-1 font-mono text-xs ${
            d.survivalActive ? "border-warn text-warn" : "border-success text-success"
          }`}
        >
          survival: {d.survivalActive ? "ACTIVE" : "off"}
        </div>
      </header>

      <Card title="Providers" subtitle={`critical=${d.criticalProvider}`}>
        <div className="space-y-3">
          {Object.entries(d.providers).map(([name, p]) => {
            const costPct = pct(p.usedCostUsd, p.budget?.maxCostUsd);
            const reqPct = pct(p.requests, p.budget?.maxRequests);
            const worst = Math.max(costPct, reqPct);
            return (
              <div key={name} className="border-l-2 border-neutral-700 pl-3">
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className={p.available ? "text-neutral-200" : "text-danger"}>{name}</span>
                  <span className="text-muted">
                    ${p.usedCostUsd.toFixed(4)}
                    {p.budget?.maxCostUsd != null && ` / $${p.budget.maxCostUsd}`} · {p.requests}r
                    {p.budget?.maxRequests != null && ` / ${p.budget.maxRequests}`}
                  </span>
                </div>
                <div className="mt-1">{bar(worst)}</div>
                {p.unavailableReason && (
                  <div className="mt-1 text-xs text-danger">⚠ {p.unavailableReason}</div>
                )}
                {p.windowResetAt && (
                  <div className="mt-0.5 text-xs text-muted">window resets {p.windowResetAt.slice(11, 19)}Z</div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="CLIs" subtitle="session-billed (Claude Max / Codex Pro / Antigravity)">
        <div className="space-y-3">
          {Object.entries(d.clis).map(([name, c]) => {
            const reqPct = pct(c.requests, c.budget?.maxRequests);
            return (
              <div key={name} className="border-l-2 border-neutral-700 pl-3">
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className={c.available ? "text-neutral-200" : "text-danger"}>{name}</span>
                  <span className="text-muted">
                    {c.requests}r{c.budget?.maxRequests != null && ` / ${c.budget.maxRequests}`}
                  </span>
                </div>
                <div className="mt-1">{bar(reqPct)}</div>
                {c.unavailableReason && (
                  <div className="mt-1 text-xs text-danger">⚠ {c.unavailableReason}</div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Survival fallback chain" subtitle="used when critical provider exhausts">
        <ol className="space-y-1 font-mono text-xs">
          {d.survivalModels.map((m, i) => (
            <li key={`${m.cli}/${m.model}`} className="text-neutral-300">
              <span className="text-muted">{i + 1}.</span> {m.cli}/{m.model} <span className="text-muted">→ {m.provider}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
