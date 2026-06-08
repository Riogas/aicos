import { safeFetch, URLS } from "@/lib/fetcher";
import { Card, Stat } from "@/components/Card";

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

interface PolicyHealth { policyEnabled: boolean; ruleCount: number }

export default async function Home() {
  const [bridge, quota, policy] = await Promise.all([
    safeFetch<BridgeHealth>(URLS.bridgeHealth()),
    safeFetch<QuotaSnapshot>(URLS.quotaStatus()),
    safeFetch<PolicyHealth>(URLS.policyHealth()),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Overview</h1>
        <p className="mt-1 text-sm text-muted">Read-only view of the AICOS runtime.</p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card title="Bridge" subtitle="paperclip ↔ CLIs" accent={bridge.ok ? "ok" : "err"}>
          {bridge.ok ? (
            <div className="grid grid-cols-2 gap-3">
              <Stat label="paperclip" value={bridge.data?.paperclip} />
              <Stat label="quota" value={bridge.data?.quota} />
              <Stat label="learning" value={bridge.data?.learning} />
              <Stat label="agents" value={String(bridge.data?.registry?.resolvableAgents ?? 0)} mono />
            </div>
          ) : (
            <span className="text-danger">{bridge.error ?? "unreachable"}</span>
          )}
        </Card>

        <Card
          title="Quota Manager"
          subtitle={quota.data?.criticalProvider ? `critical=${quota.data.criticalProvider}` : undefined}
          accent={!quota.ok ? "err" : quota.data?.survivalActive ? "warn" : "ok"}
        >
          {quota.ok ? (
            <>
              <Stat
                label="survival mode"
                value={quota.data?.survivalActive ? "ACTIVE" : "off"}
                mono
              />
              <ul className="mt-3 space-y-1 font-mono text-xs">
                {Object.entries(quota.data?.providers ?? {})
                  .filter(([, v]) => v.requests > 0 || !v.available)
                  .map(([name, v]) => (
                    <li key={name} className="flex justify-between">
                      <span className={v.available ? "text-neutral-300" : "text-danger"}>{name}</span>
                      <span className="text-muted">
                        ${v.usedCostUsd.toFixed(4)} · {v.requests}r
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          ) : (
            <span className="text-danger">{quota.error ?? "unreachable"}</span>
          )}
        </Card>

        <Card title="Policy Engine" subtitle={policy.ok ? `${policy.data?.ruleCount} rules` : undefined} accent={policy.ok ? "ok" : "err"}>
          {policy.ok ? (
            <Stat label="status" value={policy.data?.policyEnabled ? "enabled" : "disabled"} mono />
          ) : (
            <span className="text-danger">{policy.error ?? "unreachable"}</span>
          )}
        </Card>
      </div>

      <Card title="Services" subtitle="endpoints">
        <ul className="grid grid-cols-1 gap-2 font-mono text-xs md:grid-cols-2">
          <li>bridge :7100 → <code className="text-accent">/health</code> <code className="text-accent">/run</code></li>
          <li>quota :7001 → <code className="text-accent">/status</code> <code className="text-accent">/select</code> <code className="text-accent">/usage</code></li>
          <li>policy :7002 → <code className="text-accent">/evaluate</code></li>
          <li>learning :7003 → <code className="text-accent">/best-for</code> <code className="text-accent">/summary</code></li>
        </ul>
      </Card>
    </div>
  );
}
