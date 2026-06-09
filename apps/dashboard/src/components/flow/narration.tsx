"use client";

import { useEffect, useRef, useState } from "react";

export interface FlowEvent {
  id: string;
  ts: number;
  tone: "live" | "ok" | "warn" | "err" | "accent";
  source: string;        // e.g. "BRIDGE", "QUOTA", "HERMES"
  message: string;       // body
}

interface LiveRunSig {
  persona: string;
  cli: string;
  model: string;
  provider: string;
  taskType: string;
  durationMs: number;
  ticketId?: string | null;
  ts: string;
}

interface FlowSnapshot {
  liveRun?: LiveRunSig | null;
  quota?: { survival?: boolean } | null;
  bridge?: { healthy?: boolean };
  recentToolCalls?: Array<{ ts: string; tool: string; actor: string; decision: string }>;
  activeWorkers?: string[];
}

/**
 * Derives notification events from snapshot state changes.
 */
function deriveEvents(prev: FlowSnapshot | null, curr: FlowSnapshot): FlowEvent[] {
  const events: FlowEvent[] = [];
  const now = Date.now();

  // Live run started / changed
  const prevPersona = prev?.liveRun?.persona;
  const currPersona = curr.liveRun?.persona;
  if (currPersona && currPersona !== prevPersona) {
    const run = curr.liveRun!;
    events.push({
      id: `run-${run.ts}-${run.persona}`,
      ts: now,
      tone: "live",
      source: "BRIDGE",
      message: `▶ DISPATCHING ${run.persona.toUpperCase()} VIA ${run.cli.toUpperCase()}${run.ticketId ? ` · ${run.ticketId.slice(0, 12)}` : ""}`,
    });
    events.push({
      id: `quota-${run.ts}`,
      ts: now + 1,
      tone: "accent",
      source: "QUOTA",
      message: `◢ ROUTING TO ${run.model.split("/").pop()?.toUpperCase()} · PROVIDER ${run.provider.toUpperCase()}`,
    });
  }

  // Survival mode flipped on
  if (curr.quota?.survival && !prev?.quota?.survival) {
    events.push({
      id: `survival-${now}`,
      ts: now,
      tone: "warn",
      source: "QUOTA",
      message: "⚠ SURVIVAL MODE ACTIVATED — FALLBACK ENGAGED",
    });
  }

  // Survival cleared
  if (!curr.quota?.survival && prev?.quota?.survival) {
    events.push({
      id: `survival-off-${now}`,
      ts: now,
      tone: "ok",
      source: "QUOTA",
      message: "◢ SURVIVAL CLEARED · NOMINAL OPERATION",
    });
  }

  // Bridge offline
  if (prev && prev.bridge?.healthy !== false && curr.bridge?.healthy === false) {
    events.push({
      id: `bridge-down-${now}`,
      ts: now,
      tone: "err",
      source: "BRIDGE",
      message: "✕ BRIDGE LINK LOST",
    });
  }
  if (prev && prev.bridge?.healthy === false && curr.bridge?.healthy) {
    events.push({
      id: `bridge-up-${now}`,
      ts: now,
      tone: "ok",
      source: "BRIDGE",
      message: "◢ BRIDGE LINK RESTORED",
    });
  }

  // Tool calls (newest first)
  const lastSeenTool = prev?.recentToolCalls?.[0]?.ts;
  const newCalls = (curr.recentToolCalls ?? []).filter((c) => !lastSeenTool || c.ts > lastSeenTool);
  for (const c of newCalls.slice(0, 2)) {
    events.push({
      id: `tool-${c.ts}-${c.tool}`,
      ts: now,
      tone: c.decision === "deny" ? "err" : c.decision === "require_approval" ? "warn" : "live",
      source: "GATEWAY",
      message: `${c.decision === "deny" ? "✕" : "◢"} ${c.tool.toUpperCase()} · ${c.actor.toUpperCase()} · ${c.decision.toUpperCase()}`,
    });
  }

  // Active workers added
  const prevSet = new Set(prev?.activeWorkers ?? []);
  for (const w of curr.activeWorkers ?? []) {
    if (!prevSet.has(w) && w !== currPersona) {
      events.push({
        id: `worker-${w}-${now}`,
        ts: now,
        tone: "live",
        source: w.toUpperCase().replace("-", " "),
        message: `▸ AGENT ONLINE`,
      });
    }
  }

  return events;
}

/* ───────────────────────────────────────────────────────────────
   Notification feed — JARVIS comm popups
─────────────────────────────────────────────────────────────── */
interface ActiveEvent extends FlowEvent {
  spawnedAt: number;
}

const MAX_EVENTS = 5;
const DISPLAY_MS = 7000;

export function NarrationFeed({ snapshot }: { snapshot: FlowSnapshot | null }) {
  const [events, setEvents] = useState<ActiveEvent[]>([]);
  const prevSnapRef = useRef<FlowSnapshot | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const newOnes = deriveEvents(prevSnapRef.current, snapshot);
    prevSnapRef.current = snapshot;
    if (newOnes.length > 0) {
      const now = Date.now();
      setEvents((prev) => {
        const seenIds = new Set(prev.map((e) => e.id));
        const fresh = newOnes
          .filter((e) => !seenIds.has(e.id))
          .map((e) => ({ ...e, spawnedAt: now }));
        return [...fresh, ...prev].slice(0, MAX_EVENTS);
      });
    }
  }, [snapshot]);

  // Reaper: remove events older than DISPLAY_MS
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setEvents((prev) => prev.filter((e) => now - e.spawnedAt < DISPLAY_MS));
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="pointer-events-none absolute left-12 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-2">
      {events.map((e, i) => (
        <NarrationCard key={e.id} event={e} index={i} />
      ))}
    </div>
  );
}

function NarrationCard({ event, index }: { event: ActiveEvent; index: number }) {
  const tones = {
    live: { border: "border-hud", text: "text-hud", glow: "rgba(0,217,255,0.35)" },
    ok: { border: "border-success/60", text: "text-success", glow: "rgba(34,197,94,0.35)" },
    warn: { border: "border-warning/60", text: "text-warning", glow: "rgba(245,158,11,0.35)" },
    err: { border: "border-alert/60", text: "text-alert", glow: "rgba(255,59,48,0.35)" },
    accent: { border: "border-violet/60", text: "text-violet", glow: "rgba(168,85,247,0.35)" },
  };
  const t = tones[event.tone];

  // Calculate remaining lifetime → fade out gracefully near end
  const age = Date.now() - event.spawnedAt;
  const fadingOut = age > DISPLAY_MS - 800;

  return (
    <div
      className={`relative border bg-black/90 px-3 py-2 backdrop-blur-md ${t.border} ${fadingOut ? "narration-out" : "narration-in"}`}
      style={{
        clipPath:
          "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))",
        boxShadow: `0 0 16px ${t.glow}, inset 0 0 12px ${t.glow}`,
        minWidth: 280,
        maxWidth: 360,
        transform: `translateX(0)`,
        opacity: fadingOut ? 0.4 : 1,
        transition: "opacity 0.6s ease",
      }}
    >
      {/* Corner brackets */}
      <span className="hud-bracket tl" />
      <span className="hud-bracket br" />

      <div className="flex items-center justify-between">
        <span
          className={`font-mono text-[8.5px] font-bold uppercase tracking-[0.3em] ${t.text}`}
          style={{ textShadow: `0 0 6px ${t.glow}` }}
        >
          ◢ {event.source}
        </span>
        <span className="font-mono text-[8px] tabular text-hud-dim hud-flicker">
          {new Date(event.ts).toISOString().slice(11, 19)}Z
        </span>
      </div>

      <div className="mt-1.5 font-mono text-[11px] uppercase leading-tight tracking-wide text-fg">
        {event.message}
      </div>

      {/* Subtle progress line at bottom (life remaining indicator) */}
      <div className="absolute bottom-0 left-0 right-0 h-px overflow-hidden">
        <div
          className={`h-full ${t.border.replace("border", "bg")}`}
          style={{
            width: `${100 - (age / DISPLAY_MS) * 100}%`,
            transition: "width 0.5s linear",
            boxShadow: `0 0 4px ${t.glow}`,
          }}
        />
      </div>
    </div>
  );
}
