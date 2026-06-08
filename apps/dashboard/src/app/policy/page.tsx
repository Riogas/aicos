import { CircleCheck, ShieldAlert, ShieldX } from "lucide-react";
import { safeFetch, URLS } from "@/lib/fetcher";
import { Card, CardEmpty } from "@/components/Card";
import { StatusPill, Badge } from "@/components/StatusPill";

export const dynamic = "force-dynamic";

interface Rule {
  name?: string;
  effect: "allow" | "require_approval" | "deny";
  when?: Record<string, unknown>;
  reason?: string;
}

interface Ruleset { version: string; rules: Rule[] }

const EFFECT_META = {
  allow: { tone: "ok" as const, label: "allow", icon: CircleCheck },
  require_approval: { tone: "warn" as const, label: "approval", icon: ShieldAlert },
  deny: { tone: "err" as const, label: "deny", icon: ShieldX },
};

export default async function PolicyPage() {
  const res = await safeFetch<Ruleset>(URLS.policyRules());
  if (!res.ok) {
    return (
      <Card title="Policy unreachable">
        <CardEmpty>{res.error}</CardEmpty>
      </Card>
    );
  }
  const rs = res.data!;
  const counts = {
    deny: rs.rules.filter((r) => r.effect === "deny").length,
    require_approval: rs.rules.filter((r) => r.effect === "require_approval").length,
    allow: rs.rules.filter((r) => r.effect === "allow").length,
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tightest text-fg">Policy</h1>
          <p className="mt-1 text-sm text-muted">
            Rule-based authz. Precedence: <Badge tone="err">deny</Badge>{" "}
            <Badge tone="warn">approval</Badge> <Badge tone="ok">allow</Badge>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="neutral">version {rs.version}</Badge>
          <StatusPill tone="ok">{rs.rules.length} rules</StatusPill>
        </div>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <CountCard tone="err" icon={ShieldX} label="deny" count={counts.deny} />
        <CountCard tone="warn" icon={ShieldAlert} label="approval" count={counts.require_approval} />
        <CountCard tone="ok" icon={CircleCheck} label="allow" count={counts.allow} />
      </section>

      <Card title="Active ruleset" subtitle="evaluated top-down">
        <ol className="space-y-3">
          {rs.rules.map((rule, i) => {
            const meta = EFFECT_META[rule.effect];
            const Icon = meta.icon;
            return (
              <li
                key={i}
                className="overflow-hidden rounded-lg border border-border/60 bg-surface-2"
              >
                <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="font-mono text-2xs tabular text-subtle">
                      #{(i + 1).toString().padStart(2, "0")}
                    </span>
                    <span className="font-mono text-sm font-medium text-fg">
                      {rule.name ?? <span className="text-subtle">unnamed</span>}
                    </span>
                  </div>
                  <StatusPill tone={meta.tone}>
                    <Icon className="h-3 w-3" strokeWidth={2.2} />
                    {meta.label}
                  </StatusPill>
                </div>
                <div className="px-4 py-3">
                  {rule.reason && (
                    <p className="mb-3 text-sm text-fg">{rule.reason}</p>
                  )}
                  {rule.when && Object.keys(rule.when).length > 0 ? (
                    <ConditionGrid when={rule.when} />
                  ) : (
                    <div className="text-2xs text-subtle">
                      no conditions — catch-all
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}

function CountCard({
  tone,
  icon: Icon,
  label,
  count,
}: {
  tone: "ok" | "warn" | "err";
  icon: React.ElementType;
  label: string;
  count: number;
}) {
  const ringTone =
    tone === "err"
      ? "border-danger/30 bg-danger-soft text-danger"
      : tone === "warn"
        ? "border-warning/30 bg-warning-soft text-warning"
        : "border-success/30 bg-success-soft text-success";
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface bg-card-bevel p-4 shadow-card">
      <div className="flex items-center gap-3">
        <div className={`grid h-10 w-10 place-items-center rounded-md border ${ringTone}`}>
          <Icon className="h-4 w-4" strokeWidth={2} />
        </div>
        <div>
          <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">{label}</div>
          <div className="font-mono text-2xl font-semibold tabular text-fg">{count}</div>
        </div>
      </div>
    </div>
  );
}

function ConditionGrid({ when }: { when: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {Object.entries(when).map(([k, v]) => (
        <div
          key={k}
          className="flex items-baseline gap-2 rounded border border-border/40 bg-bg px-2 py-1.5 font-mono text-2xs"
        >
          <span className="text-subtle">{k}</span>
          <span className="truncate text-fg">{formatValue(v)}</span>
        </div>
      ))}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}
