import Link from "next/link";
import {
  Activity,
  CircleCheck,
  CircleX,
  Cpu,
  Database,
  DollarSign,
  Gauge,
  Network,
  Shield,
  Sparkles,
  Users,
} from "lucide-react";
import { safeFetch, URLS } from "@/lib/fetcher";
import { Card, CardEmpty } from "@/components/Card";
import { MetricTile } from "@/components/MetricTile";
import { StatusPill, Badge } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

interface BridgeHealth {
  status?: string;
  paperclip?: string;
  quota?: string;
  learning?: string;
  registry?: { resolvableAgents?: number };
}

interface QuotaSnapshot {
  criticalProvider: string;
  survivalActive: boolean;
  providers: Record<string, { available: boolean; usedCostUsd: number; requests: number }>;
}

interface PolicyHealth {
  policyEnabled: boolean;
  ruleCount: number;
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
  ts?: string;
}

export default async function Home() {
  const [bridge, quota, policy, recent] = await Promise.all([
    safeFetch<BridgeHealth>(URLS.bridgeHealth()),
    safeFetch<QuotaSnapshot>(URLS.quotaStatus()),
    safeFetch<PolicyHealth>(URLS.policyHealth()),
    safeFetch<{ items: RecentItem[] }>(URLS.learningRecent()),
  ]);

  const totalCost = quota.ok
    ? Object.values(quota.data?.providers ?? {}).reduce((s, p) => s + p.usedCostUsd, 0)
    : 0;
  const totalReqs = quota.ok
    ? Object.values(quota.data?.providers ?? {}).reduce((s, p) => s + p.requests, 0)
    : 0;
  const activeProviders = quota.ok
    ? Object.values(quota.data?.providers ?? {}).filter((p) => p.requests > 0).length
    : 0;
  const recentCount = recent.ok ? recent.data?.items?.length ?? 0 : 0;
  const successCount = recent.ok
    ? (recent.data?.items ?? []).filter((r) => r.success).length
    : 0;
  const successPct = recentCount > 0 ? Math.round((successCount / recentCount) * 100) : 0;

  return (
    <div className="space-y-8 animate-fade-in">
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tightest text-fg">Overview</h1>
            <p className="mt-1 text-sm text-muted">
              Read-only view of the AICOS runtime. Refreshes on every load.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-subtle">Critical provider</span>
            <Badge tone="accent">{quota.data?.criticalProvider ?? "—"}</Badge>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          label="Spend (1h window)"
          value={`$${totalCost.toFixed(2)}`}
          hint={`across ${activeProviders} active providers`}
          icon={DollarSign}
          tone={totalCost > 5 ? "warn" : "ok"}
        />
        <MetricTile
          label="Requests"
          value={String(totalReqs)}
          hint="rolling 1h window"
          icon={Activity}
          tone="accent"
        />
        <MetricTile
          label="Agents resolvable"
          value={String(bridge.data?.registry?.resolvableAgents ?? 0)}
          hint="registry × paperclip keys"
          icon={Users}
        />
        <MetricTile
          label="Success rate (today)"
          value={`${successPct}`}
          unit="%"
          hint={`${successCount} / ${recentCount} runs ok`}
          icon={CircleCheck}
          tone={successPct >= 95 ? "ok" : successPct >= 80 ? "warn" : "err"}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ServiceCard
          name="Bridge"
          port={7100}
          icon={Network}
          href="/runs"
          ok={bridge.ok}
          error={bridge.error}
        >
          {bridge.ok ? (
            <div className="grid grid-cols-3 gap-3 text-xs">
              <ServiceFlag label="paperclip" value={bridge.data?.paperclip} />
              <ServiceFlag label="quota" value={bridge.data?.quota} />
              <ServiceFlag label="learning" value={bridge.data?.learning} />
            </div>
          ) : (
            <CardEmpty>{bridge.error}</CardEmpty>
          )}
        </ServiceCard>

        <ServiceCard
          name="Quota Manager"
          port={7001}
          icon={Gauge}
          href="/quota"
          ok={quota.ok}
          error={quota.error}
          badge={
            quota.data?.survivalActive ? (
              <StatusPill tone="warn" pulse>
                Survival
              </StatusPill>
            ) : null
          }
        >
          {quota.ok ? (
            <div className="space-y-1.5 font-mono text-xs">
              {Object.entries(quota.data?.providers ?? {})
                .filter(([, v]) => v.requests > 0 || !v.available)
                .slice(0, 5)
                .map(([name, v]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between rounded-md border border-border/40 bg-surface-2 px-2 py-1"
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          v.available ? "bg-success" : "bg-danger"
                        }`}
                      />
                      <span className="text-muted">{name}</span>
                    </div>
                    <span className="tabular text-subtle">
                      ${v.usedCostUsd.toFixed(3)} · {v.requests}r
                    </span>
                  </div>
                ))}
              {Object.values(quota.data?.providers ?? {}).every(
                (p) => p.requests === 0 && p.available,
              ) && <CardEmpty>No activity yet</CardEmpty>}
            </div>
          ) : (
            <CardEmpty>{quota.error}</CardEmpty>
          )}
        </ServiceCard>

        <ServiceCard
          name="Policy Engine"
          port={7002}
          icon={Shield}
          href="/policy"
          ok={policy.ok}
          error={policy.error}
        >
          {policy.ok ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">
                  rules
                </div>
                <div className="font-mono text-2xl font-semibold tabular text-fg">
                  {policy.data?.ruleCount}
                </div>
              </div>
              <div>
                <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">
                  status
                </div>
                <div className="mt-1">
                  <StatusPill tone={policy.data?.policyEnabled ? "ok" : "neutral"}>
                    {policy.data?.policyEnabled ? "enabled" : "disabled"}
                  </StatusPill>
                </div>
              </div>
            </div>
          ) : (
            <CardEmpty>{policy.error}</CardEmpty>
          )}
        </ServiceCard>
      </section>

      <Card
        title="Recent activity"
        subtitle="learning audit · last 50 today"
        action={
          <Link
            href="/runs"
            className="text-xs font-medium text-accent hover:underline"
          >
            view all →
          </Link>
        }
      >
        {!recent.ok || !recent.data?.items?.length ? (
          <CardEmpty>{recent.error ?? "No runs today."}</CardEmpty>
        ) : (
          <ul className="divide-y divide-border/60">
            {recent.data.items.slice(0, 8).map((r, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 py-2.5 text-xs"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  {r.success ? (
                    <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2.2} />
                  ) : (
                    <CircleX className="h-3.5 w-3.5 shrink-0 text-danger" strokeWidth={2.2} />
                  )}
                  <span className="font-mono tabular text-subtle">
                    {(r.ts ?? "").slice(11, 19)}
                  </span>
                  <span className="font-mono text-fg">{r.agentRegistryId ?? "—"}</span>
                  <span className="hidden text-muted sm:inline">
                    via {r.cli}/<span className="text-fg">{r.model.split("/").pop()}</span>
                  </span>
                  <Badge tone="neutral" className="hidden md:inline-flex">
                    {r.taskType}
                  </Badge>
                </div>
                <div className="flex shrink-0 items-center gap-3 font-mono text-2xs tabular text-subtle">
                  <span>{r.durationMs}ms</span>
                  <span className={r.costUsd > 0 ? "text-fg" : "text-subtle"}>
                    ${r.costUsd.toFixed(4)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Services" subtitle="endpoints">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <ServiceRow icon={Network} name="bridge" port={7100} endpoints={["/health", "/run"]} />
          <ServiceRow icon={Gauge} name="quota" port={7001} endpoints={["/status", "/select", "/usage"]} />
          <ServiceRow icon={Shield} name="policy" port={7002} endpoints={["/evaluate", "/rules"]} />
          <ServiceRow icon={Sparkles} name="learning" port={7003} endpoints={["/best-for", "/summary"]} />
          <ServiceRow icon={Database} name="postgres" port={5432} endpoints={["aicos", "paperclip"]} />
          <ServiceRow icon={Cpu} name="paperclip" port={3100} endpoints={["/api/issues", "/app"]} />
        </div>
      </Card>
    </div>
  );
}

function ServiceCard({
  name,
  port,
  icon: Icon,
  href,
  ok,
  badge,
  error,
  children,
}: {
  name: string;
  port: number;
  icon: React.ElementType;
  href: string;
  ok: boolean;
  badge?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className="group block">
      <Card
        title={name}
        subtitle={`:${port}`}
        action={
          badge ?? <StatusPill tone={ok ? "ok" : "err"}>{ok ? "healthy" : "down"}</StatusPill>
        }
        className="h-full transition-transform group-hover:-translate-y-0.5"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-surface-2">
            <Icon className="h-4 w-4 text-muted" strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </Card>
    </Link>
  );
}

function ServiceFlag({ label, value }: { label: string; value?: string }) {
  const ok = value === "configured";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-2xs uppercase tracking-tightest text-subtle">{label}</span>
      <span className={`font-mono text-xs font-medium ${ok ? "text-success" : "text-danger"}`}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function ServiceRow({
  icon: Icon,
  name,
  port,
  endpoints,
}: {
  icon: React.ElementType;
  name: string;
  port: number;
  endpoints: string[];
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-surface-2 px-3 py-2 transition-colors hover:border-border-strong">
      <div className="grid h-7 w-7 place-items-center rounded border border-border bg-surface">
        <Icon className="h-3.5 w-3.5 text-muted" strokeWidth={1.8} />
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-medium text-fg">{name}</span>
          <span className="font-mono text-2xs text-subtle">:{port}</span>
        </div>
        <div className="flex flex-wrap gap-1 font-mono text-2xs text-muted">
          {endpoints.map((e) => (
            <code key={e} className="rounded bg-surface px-1 py-0.5">
              {e}
            </code>
          ))}
        </div>
      </div>
    </div>
  );
}
