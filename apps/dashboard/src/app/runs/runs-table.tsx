"use client";

import { useState } from "react";
import { CircleCheck, CircleX, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/StatusPill";

export interface RecentItem {
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

interface ResultState {
  loading: boolean;
  error?: string;
  result?: string | null;
  status?: string | null;
  title?: string | null;
}

export function RunsTable({ items }: { items: RecentItem[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, ResultState>>({});

  const toggle = async (i: number, item: RecentItem) => {
    if (openIdx === i) {
      setOpenIdx(null);
      return;
    }
    setOpenIdx(i);
    if (!results[i] && item.ticketId) {
      setResults((p) => ({ ...p, [i]: { loading: true } }));
      try {
        const r = await fetch(`/api/run-result?ticket=${encodeURIComponent(item.ticketId)}`, {
          cache: "no-store",
        });
        const d = await r.json();
        setResults((p) => ({
          ...p,
          [i]: {
            loading: false,
            result: d.result ?? null,
            status: d.issue?.status ?? null,
            title: d.issue?.title ?? null,
            error: r.ok ? undefined : d.error ?? `HTTP ${r.status}`,
          },
        }));
      } catch (e) {
        setResults((p) => ({ ...p, [i]: { loading: false, error: (e as Error).message } }));
      }
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border/60 text-left font-mono text-2xs uppercase tracking-tightest text-subtle">
            <th className="w-6 py-2" />
            <th className="py-2 pr-3 font-normal">time</th>
            <th className="py-2 pr-3 font-normal">agent</th>
            <th className="py-2 pr-3 font-normal">ticket</th>
            <th className="py-2 pr-3 font-normal">task</th>
            <th className="py-2 pr-3 font-normal">cli/model</th>
            <th className="py-2 pr-3 font-normal">provider</th>
            <th className="py-2 pr-3 font-normal">status</th>
            <th className="py-2 pr-3 text-right font-normal">ms</th>
            <th className="py-2 pr-3 text-right font-normal">cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {items.map((r, i) => {
            const open = openIdx === i;
            const res = results[i];
            return (
              <>
                <tr
                  key={i}
                  onClick={() => toggle(i, r)}
                  className="cursor-pointer text-xs transition-colors hover:bg-surface-2"
                >
                  <td className="py-2 pl-1 text-subtle">
                    <ChevronRight
                      className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
                      strokeWidth={2}
                    />
                  </td>
                  <td className="py-2 pr-3 font-mono tabular text-subtle">{(r.ts ?? "").slice(11, 19)}</td>
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
                  <td className="py-2 pr-3 text-right font-mono tabular text-muted">{r.durationMs}</td>
                  <td className="py-2 pr-3 text-right font-mono tabular text-muted">
                    ${r.costUsd.toFixed(4)}
                  </td>
                </tr>
                {open && (
                  <tr key={`${i}-detail`} className="bg-surface/60">
                    <td />
                    <td colSpan={9} className="px-3 py-3">
                      {!r.ticketId ? (
                        <p className="text-xs text-subtle">
                          Este run no tiene ticket asociado — no hay resultado para mostrar.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {res?.loading ? (
                            <p className="flex items-center gap-2 text-xs text-muted">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Trayendo resultado de {r.ticketId}…
                            </p>
                          ) : res?.error ? (
                            <p className="text-xs text-danger">No pude traer el resultado: {res.error}</p>
                          ) : res?.result ? (
                            <div>
                              <div className="mb-1.5 flex items-center gap-2 font-mono text-2xs uppercase tracking-tightest text-subtle">
                                <span className="text-accent">◢ resultado final</span>
                                {res.status && <Badge tone="neutral">{res.status}</Badge>}
                                {res.title && <span className="truncate text-subtle">{res.title}</span>}
                              </div>
                              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-bg/60 p-3 text-xs leading-relaxed text-fg/90">
                                {res.result}
                              </pre>
                            </div>
                          ) : (
                            <p className="text-xs text-subtle">
                              El agente no dejó un comentario de resultado en {r.ticketId} (quizás falló sin output).
                            </p>
                          )}
                          <TranscriptViewer ticket={r.ticketId} />
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface TEntry { kind: "text" | "tool" | "thinking" | "system" | "result"; text: string }

function TranscriptViewer({ ticket }: { ticket: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<TEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (entries || loading) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/run-transcript?ticket=${encodeURIComponent(ticket)}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) setError(d.error || `HTTP ${r.status}`);
      else setEntries(d.entries || []);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div className="border-t border-border/40 pt-2.5">
      <button onClick={load} className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-tightest text-hud hover:text-fg">
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} strokeWidth={2.2} />
        transcript completo
      </button>
      {open && (
        <div className="mt-2">
          {loading ? (
            <p className="flex items-center gap-2 text-xs text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" /> bajando transcript…</p>
          ) : error ? (
            <p className="text-xs text-subtle">{error}</p>
          ) : entries && entries.length ? (
            <div className="max-h-[520px] space-y-1.5 overflow-auto rounded-md border border-border/60 bg-bg/60 p-3">
              {entries.map((e, i) => <TLine key={i} e={e} />)}
            </div>
          ) : (
            <p className="text-xs text-subtle">Sin transcript para este run.</p>
          )}
        </div>
      )}
    </div>
  );
}

function TLine({ e }: { e: TEntry }) {
  if (e.kind === "system")
    return <div className="font-mono text-2xs text-ghost">{e.text}</div>;
  if (e.kind === "thinking")
    return <div className="border-l-2 border-violet/30 pl-2 text-xs italic text-subtle">{e.text}</div>;
  if (e.kind === "tool")
    return <div className="font-mono text-2xs text-warning">⚙ {e.text}</div>;
  if (e.kind === "result")
    return (
      <div className="mt-1 rounded border border-accent/30 bg-accent/5 p-2">
        <div className="mb-1 font-mono text-2xs uppercase tracking-tightest text-accent">resultado</div>
        <div className="whitespace-pre-wrap text-xs text-fg/90">{e.text}</div>
      </div>
    );
  return <div className="whitespace-pre-wrap text-xs leading-relaxed text-fg/90">{e.text}</div>;
}
