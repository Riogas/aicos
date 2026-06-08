import { safeFetch, URLS } from "@/lib/fetcher";
import { Card } from "@/components/Card";

export const dynamic = "force-dynamic";

interface Rule {
  name?: string;
  effect: "allow" | "require_approval" | "deny";
  when?: Record<string, unknown>;
  reason?: string;
}

interface Ruleset { version: string; rules: Rule[] }

export default async function PolicyPage() {
  const res = await safeFetch<Ruleset>(URLS.policyRules());
  if (!res.ok) return <Card title="Policy unreachable" accent="err">{res.error}</Card>;
  const rs = res.data!;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Policy</h1>
        <p className="mt-1 text-sm text-muted">Active ruleset · version {rs.version}</p>
      </header>
      <Card title={`Rules (${rs.rules.length})`} subtitle="deny > require_approval > allow precedence">
        <ol className="space-y-2">
          {rs.rules.map((rule, i) => {
            const tone =
              rule.effect === "deny"
                ? "border-danger text-danger"
                : rule.effect === "require_approval"
                  ? "border-warn text-warn"
                  : "border-success text-success";
            return (
              <li key={i} className="rounded border border-border bg-bg p-3">
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="text-neutral-200">{i + 1}. {rule.name ?? "<unnamed>"}</span>
                  <span className={`rounded border px-2 py-0.5 ${tone}`}>{rule.effect}</span>
                </div>
                {rule.reason && (
                  <p className="mt-2 text-sm text-neutral-300">{rule.reason}</p>
                )}
                {rule.when && Object.keys(rule.when).length > 0 && (
                  <pre className="mt-2 overflow-x-auto rounded bg-black p-2 font-mono text-xs text-neutral-400">
{JSON.stringify(rule.when, null, 2)}
                  </pre>
                )}
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
