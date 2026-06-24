"use client";

import { useEffect, useRef, useState } from "react";
import type { FlowEvent } from "./narration";

/* ───────────────────────────────────────────────────────────────
   Live UTC clock — ticks every 500ms, blinking separator.
─────────────────────────────────────────────────────────────── */
export function HudClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 500);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="font-mono text-[11px] font-bold tabular tracking-widest text-hud glow-text">
      {p(now.getUTCHours())}
      <span className="clock-sep">:</span>
      {p(now.getUTCMinutes())}
      <span className="clock-sep">:</span>
      {p(now.getUTCSeconds())}
      <span className="ml-1 text-[8px] font-normal text-hud-dim">UTC</span>
    </span>
  );
}

/* ───────────────────────────────────────────────────────────────
   Top status strip — mode, live counts, clock.
─────────────────────────────────────────────────────────────── */
export function StatusStrip({
  survival,
  liveCount,
  agentCount,
  healthy,
}: {
  survival: boolean;
  liveCount: number;
  agentCount: number;
  healthy: boolean;
}) {
  const mode = survival ? "SURVIVAL" : liveCount > 0 ? "ENGAGED" : "NOMINAL";
  const modeCls = survival
    ? "text-alert glow-text-alert"
    : liveCount > 0
      ? "text-hud glow-text"
      : "text-success";
  return (
    <div className="pointer-events-none absolute left-1/2 top-2.5 z-20 flex -translate-x-1/2 items-center gap-4 border border-hud-dim bg-black/70 px-4 py-1.5 backdrop-blur-md"
      style={{
        clipPath: "polygon(12px 0, calc(100% - 12px) 0, 100% 100%, 0 100%)",
        boxShadow: "0 0 18px rgba(0,255,156,0.12)",
      }}
    >
      <HudClock />
      <span className="h-3 w-px bg-hud-dim" />
      <span className="font-mono text-[9px] uppercase tracking-[0.25em]">
        <span className="text-hud-dim">MODE </span>
        <span className={modeCls}>{mode}</span>
      </span>
      <span className="h-3 w-px bg-hud-dim" />
      <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-hud-dim">
        ACTIVE <span className="tabular text-hud glow-text">{liveCount}</span>
        <span className="mx-1">/</span>
        <span className="tabular">{agentCount}</span> AG
      </span>
      <span className="h-3 w-px bg-hud-dim" />
      <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em]">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${healthy ? "bg-success" : "bg-alert"}`}
          style={{ boxShadow: healthy ? "0 0 6px rgba(34,197,94,0.9)" : "0 0 6px rgba(255,59,48,0.9)" }}
        />
        <span className={healthy ? "text-success" : "text-alert glow-text-alert"}>
          {healthy ? "LINK OK" : "LINK LOST"}
        </span>
      </span>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Bottom ticker tape — recent runs marquee (stock-ticker style).
─────────────────────────────────────────────────────────────── */
interface RecentRun {
  persona: string;
  cli: string;
  model: string;
  provider: string;
  success: boolean;
  durationMs: number;
  costUsd: number;
  ts: string;
}

export function TickerTape({ recent }: { recent: RecentRun[] }) {
  if (!recent || recent.length === 0) return null;
  const items = recent.slice(0, 18);
  const cell = (r: RecentRun, i: number) => (
    <span key={i} className="inline-flex items-center gap-1.5 px-5 py-1 font-mono text-[9px] uppercase tracking-wider">
      <span className={r.success ? "text-success" : "text-alert glow-text-alert"}>
        {r.success ? "▲" : "▼"}
      </span>
      <span className="text-fg">{r.persona}</span>
      <span className="text-hud-dim">·</span>
      <span className="text-hud">{r.cli}</span>
      <span className="text-hud-dim">{(r.model || "").split("/").pop()}</span>
      <span className="text-hud-dim">·</span>
      <span className="tabular text-hud-dim">{(r.durationMs / 1000).toFixed(1)}s</span>
      <span className="tabular text-gold glow-text-gold">${r.costUsd.toFixed(3)}</span>
      <span className="ml-3 text-hud-dim opacity-40">◆</span>
    </span>
  );
  return (
    <div className="ticker-wrap">
      {/* Track duplicated so the -50% translate loops seamlessly */}
      <div className="ticker-track">
        {items.map(cell)}
        {items.map((r, i) => cell(r, i + 100))}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Console — persistent terminal log of derived events.
─────────────────────────────────────────────────────────────── */
const TONE_TEXT: Record<FlowEvent["tone"], string> = {
  live: "text-hud",
  ok: "text-success",
  warn: "text-warning",
  err: "text-alert",
  accent: "text-violet",
};

export function ConsolePanel({ log }: { log: FlowEvent[] }) {
  return (
    <div className="console-panel px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[8.5px] uppercase tracking-[0.3em] text-hud glow-text">
          ◢ SYSTEM LOG
        </span>
        <span className="font-mono text-[8px] tabular uppercase tracking-widest text-hud-dim">
          {log.length} EV
        </span>
      </div>
      <div className="my-1 h-px bg-hud-dim" />
      <div className="flex flex-col-reverse gap-0.5">
        {log.slice(0, 9).map((e) => (
          <div key={e.id} className="console-line flex items-baseline gap-1.5 font-mono text-[8.5px] leading-snug">
            <span className="shrink-0 tabular text-hud-dim opacity-60">
              {new Date(e.ts).toISOString().slice(11, 19)}
            </span>
            <span className={`shrink-0 font-bold uppercase ${TONE_TEXT[e.tone]}`}>
              [{e.source}]
            </span>
            <span className="truncate uppercase tracking-wide text-fg/80">{e.message}</span>
          </div>
        ))}
        {log.length === 0 && (
          <div className="font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
            ▸ AWAITING TELEMETRY<span className="boot-cursor" />
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   AGENT UPLINK — live streaming output of the active run (the agent's
   actual text / tool calls as it works, via SSE "output" events).
─────────────────────────────────────────────────────────────── */
export interface UplinkChunk {
  seq: number;
  kind: "text" | "tool" | "thinking";
  text: string;
  at: string;
}
export interface UplinkRun {
  runId: string;
  persona?: string;
  personaName?: string;
  ticketIdentifier?: string;
  chunks: UplinkChunk[];
  lastAt: number;
}

export function AgentUplink({ runs }: { runs: UplinkRun[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Show the most-recently-active run.
  const active = runs.length
    ? runs.reduce((a, b) => (b.lastAt > a.lastAt ? b : a))
    : null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.chunks.length, active?.runId]);

  if (!active) return null;

  return (
    <div
      className="pointer-events-none absolute bottom-16 right-12 z-20 w-[420px] border border-hud-dim bg-black/85 backdrop-blur-md"
      style={{
        clipPath: "polygon(14px 0, 100% 0, 100% 100%, 0 100%, 0 14px)",
        boxShadow: "0 0 26px rgba(0,255,156,0.14)",
      }}
    >
      <div className="flex items-center justify-between border-b border-hud-dim px-3 py-1.5">
        <span className="font-mono text-[8.5px] uppercase tracking-[0.3em] text-hud glow-text">
          ◢ AGENT UPLINK
        </span>
        <span className="truncate font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
          {active.personaName ?? active.persona ?? "agent"}
          {active.ticketIdentifier ? ` · ${active.ticketIdentifier}` : ""}
          <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-hud align-middle"
            style={{ boxShadow: "0 0 6px #00ff9c" }} />
        </span>
      </div>
      <div ref={scrollRef} className="max-h-[260px] overflow-y-auto px-3 py-2">
        {active.chunks.slice(-80).map((c) => (
          <UplinkLine key={c.seq} chunk={c} />
        ))}
        {runs.length > 1 && (
          <div className="mt-1 font-mono text-[8px] uppercase tracking-widest text-hud-dim opacity-50">
            +{runs.length - 1} otro(s) agente(s) activo(s)
          </div>
        )}
      </div>
    </div>
  );
}

function UplinkLine({ chunk }: { chunk: UplinkChunk }) {
  if (chunk.kind === "tool") {
    return (
      <div className="console-line my-0.5 font-mono text-[9px] leading-snug text-gold glow-text-gold">
        <span className="opacity-70">▸ </span>
        <span className="uppercase tracking-wide">{chunk.text}</span>
      </div>
    );
  }
  if (chunk.kind === "thinking") {
    return (
      <div className="console-line whitespace-pre-wrap font-mono text-[9px] italic leading-snug text-subtle opacity-70">
        {chunk.text.length > 600 ? chunk.text.slice(0, 600) + "…" : chunk.text}
      </div>
    );
  }
  return (
    <div className="console-line whitespace-pre-wrap font-mono text-[9.5px] leading-snug text-fg/90">
      {chunk.text}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Sparkline — tiny bar histogram of recent runs by 10-min buckets.
─────────────────────────────────────────────────────────────── */
export function RunsSparkline({ recent }: { recent: RecentRun[] }) {
  const BUCKETS = 12;
  const BUCKET_MS = 10 * 60 * 1000;
  const now = Date.now();
  const counts = new Array(BUCKETS).fill(0);
  const fails = new Array(BUCKETS).fill(0);
  for (const r of recent ?? []) {
    const age = now - new Date(r.ts).getTime();
    const b = BUCKETS - 1 - Math.floor(age / BUCKET_MS);
    if (b >= 0 && b < BUCKETS) {
      counts[b]++;
      if (!r.success) fails[b]++;
    }
  }
  const max = Math.max(1, ...counts);
  return (
    <div className="flex h-6 items-end gap-[2px]" title="Runs últimas 2h (rojo = fallos)">
      {counts.map((c, i) => {
        const h = Math.max(2, Math.round((c / max) * 22));
        const hasFail = fails[i] > 0;
        return (
          <div key={i} className="flex w-[7px] flex-col justify-end" style={{ height: 24 }}>
            <div
              style={{
                height: h,
                background: c === 0 ? "rgba(0,255,156,0.12)" : hasFail ? "#ff3b30" : "#00ff9c",
                boxShadow: c > 0 ? `0 0 4px ${hasFail ? "rgba(255,59,48,0.8)" : "rgba(0,255,156,0.8)"}` : "none",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
