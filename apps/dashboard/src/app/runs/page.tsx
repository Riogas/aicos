import { safeFetch, URLS } from "@/lib/fetcher";
import { Card } from "@/components/Card";

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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Runs</h1>
        <p className="mt-1 text-sm text-muted">
          Last 50 agent runs today · sourced from learning service audit log
        </p>
      </header>

      <Card title="Today's runs">
        {!recent.ok || !recent.data?.items?.length ? (
          <span className="text-muted">{recent.error ?? "no runs today"}</span>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1 pr-3">ts</th>
                  <th className="py-1 pr-3">agent</th>
                  <th className="py-1 pr-3">ticket</th>
                  <th className="py-1 pr-3">task</th>
                  <th className="py-1 pr-3">cli/model</th>
                  <th className="py-1 pr-3">provider</th>
                  <th className="py-1 pr-3">status</th>
                  <th className="py-1 pr-3">ms</th>
                  <th className="py-1 pr-3">cost</th>
                  <th className="py-1 pr-3">err</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.items.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1 pr-3 text-muted">{(r.ts ?? "").slice(11, 19)}</td>
                    <td className="py-1 pr-3 text-neutral-300">{r.agentRegistryId ?? "-"}</td>
                    <td className="py-1 pr-3 text-neutral-400">{r.ticketId ?? "-"}</td>
                    <td className="py-1 pr-3 text-neutral-400">{r.taskType}</td>
                    <td className="py-1 pr-3">{r.cli}/{r.model}</td>
                    <td className="py-1 pr-3 text-neutral-400">{r.provider}</td>
                    <td className="py-1 pr-3">
                      {r.success ? <span className="text-success">✓ ok</span> : <span className="text-danger">✗ fail</span>}
                    </td>
                    <td className="py-1 pr-3 text-neutral-400">{r.durationMs}</td>
                    <td className="py-1 pr-3 text-neutral-400">${r.costUsd.toFixed(4)}</td>
                    <td className="py-1 pr-3 text-danger">{r.failureReason ?? ""}</td>
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
