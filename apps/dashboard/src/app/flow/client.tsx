"use client";

import "@xyflow/react/dist/style.css";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeTypes,
  type EdgeTypes,
  MarkerType,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { NarrationFeed, useFlowEvents } from "@/components/flow/narration";
import { BootSequence } from "@/components/flow/boot";
import { StatusStrip, TickerTape, ConsolePanel, RunsSparkline } from "@/components/flow/hud-chrome";
import {
  OperatorNode,
  BrainNode,
  PaperclipNode,
  BridgeNode,
  WorkerNode,
  CliNode,
  ProviderNode,
  ServiceNode,
} from "@/components/flow/nodes";
import { AnimatedEdge } from "@/components/flow/edges";

interface LiveRunEntry {
  persona: string;
  personaName: string;
  cli: string;
  model: string;
  provider: string;
  ticketId: string | null;
  ticketIdentifier: string | null;
  parentIssueId: string | null;
  triggeredBy: "telegram" | "paperclip" | "manual";
  startedAt: string;
  ageMs: number;
  /** dispatched | memory-retrieve | quota-select | cli-running | posting-result | done */
  stage?: string | null;
}

interface TreeEntry {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  childrenLive: Array<{ persona: string; identifier: string | null; cli: string }>;
}

interface FlowState {
  ts: string;
  bridge: { healthy: boolean; paperclip: string; quota: string; learning: string; agentCount: number };
  quota?: {
    critical: string;
    survival: boolean;
    providers: Record<string, { usedCostUsd: number; requests: number; available: boolean; pct: number }>;
    clis: Record<string, { requests: number; available: boolean }>;
  } | null;
  liveRun?: {
    persona: string;
    cli: string;
    model: string;
    provider: string;
    taskType: string;
    success: boolean;
    durationMs: number;
    ticketId?: string | null;
    ts: string;
  } | null;
  liveRuns: LiveRunEntry[];
  tree: TreeEntry[];
  recent: Array<{
    persona: string;
    cli: string;
    model: string;
    provider: string;
    success: boolean;
    durationMs: number;
    costUsd: number;
    ts: string;
  }>;
  activeWorkers: string[];
  activeClis: string[];
  activeProviders: string[];
  activeServices: { quota: boolean; memory: boolean; learning: boolean; gateway: boolean; policy: boolean };
  operatorActive: boolean;
  paperclipActive: boolean;
  recentToolCalls: Array<{ ts: string; tool: string; actor: string; action: string; decision: string }>;
  totals: { totalRunsToday: number; successRate: number; totalCostToday: number; activeAgentCount?: number };
}

const nodeTypes: NodeTypes = {
  operator: OperatorNode,
  brain: BrainNode,
  paperclip: PaperclipNode,
  bridge: BridgeNode,
  worker: WorkerNode,
  cli: CliNode,
  provider: ProviderNode,
  service: ServiceNode,
};

const edgeTypes: EdgeTypes = { animated: AnimatedEdge };

// Layout constants — spread for full-screen viewport
const ROW_GAP = 92;
const X = {
  op: 60,
  hermes: 360,
  paperclip: 700,
  bridge: 1080,
  workers: 1440,
  clis: 1800,
  providers: 2120,
};
const CENTER_Y = 460; // main horizontal pipeline Y (op→bridge)

const WORKERS = [
  { id: "it-analyst", name: "IT Analyst", role: "analyst", department: "IT", y: 0 },
  { id: "it-architect", name: "IT Architect", role: "architect", department: "IT", y: ROW_GAP },
  { id: "it-implementer", name: "IT Implementer", role: "impl", department: "IT", y: ROW_GAP * 2 },
  { id: "it-code-reviewer", name: "Code Reviewer", role: "review", department: "IT", y: ROW_GAP * 3 },
  { id: "it-security-reviewer", name: "Security Rev", role: "security", department: "IT", y: ROW_GAP * 4 },
  { id: "it-documenter", name: "IT Documenter", role: "docs", department: "IT", y: ROW_GAP * 5 },
  { id: "it-ui-ux-validator", name: "UX Validator", role: "ux", department: "IT", y: ROW_GAP * 6 },
  { id: "marketing-strategist", name: "MK Strategist", role: "strategy", department: "MK", y: ROW_GAP * 7 },
  { id: "marketing-copywriter", name: "Copywriter", role: "copy", department: "MK", y: ROW_GAP * 8 },
  { id: "research-market", name: "Market Analyst", role: "research", department: "RX", y: ROW_GAP * 9 },
];

const CLIS = [
  { id: "claude", name: "claude", y: ROW_GAP * 1 },
  { id: "codex", name: "codex", y: ROW_GAP * 3 },
  { id: "agy", name: "agy", y: ROW_GAP * 5 },
  { id: "opencode", name: "opencode", y: ROW_GAP * 7 },
  { id: "hermes-cli", name: "hermes", y: ROW_GAP * 9 },
];

const CLI_TO_PROVIDER: Record<string, string[]> = {
  claude: ["anthropic"],
  codex: ["openai"],
  agy: ["google"],
  opencode: ["moonshot", "xiaomi", "opencode-free"],
  "hermes-cli": ["openai", "anthropic", "google"],
};

const PROVIDERS = [
  { id: "anthropic", name: "anthropic", y: ROW_GAP * 1 },
  { id: "openai", name: "openai", y: ROW_GAP * 3 },
  { id: "google", name: "google", y: ROW_GAP * 5 },
  { id: "moonshot", name: "moonshot", y: ROW_GAP * 6.5 },
  { id: "xiaomi", name: "xiaomi", y: ROW_GAP * 8 },
  { id: "opencode-free", name: "opencode-free", y: ROW_GAP * 9.5 },
];

export function FlowViewer() {
  const [state, setState] = useState<FlowState | null>(null);

  useEffect(() => {
    let stopped = false;

    // Pull the heavy aggregated snapshot from /api/flow-state. SSE only tells
    // us "something changed in the tracker" — quota, learning, tree, etc.
    // still come from this poll. So we keep polling but slow it down when SSE
    // is connected (5s instead of 2s).
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetch("/api/flow-state", { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as FlowState;
        if (!stopped) setState(data);
      } catch {
        /* noop */
      }
    };

    let pollMs = 2000;
    let pollId: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      tick();
      if (pollId) clearInterval(pollId);
      pollId = setInterval(tick, pollMs);
    };
    startPolling();

    // EventSource fast-path: when a tracker event arrives, fire an immediate
    // tick so the visual update doesn't wait for the next poll boundary.
    // Cap one fast-tick per 750 ms so a burst of stage events doesn't hammer
    // the API.
    let lastFastTickAt = 0;
    let es: EventSource | null = null;
    const setupSSE = () => {
      try {
        es = new EventSource("/api/flow-events");
        es.onopen = () => {
          // Drop polling to a slow heartbeat once SSE is live.
          pollMs = 5000;
          startPolling();
        };
        const onAnyEvent = () => {
          const t = Date.now();
          if (t - lastFastTickAt < 750) return;
          lastFastTickAt = t;
          void tick();
        };
        es.addEventListener("start", onAnyEvent);
        es.addEventListener("stage", onAnyEvent);
        es.addEventListener("update", onAnyEvent);
        es.addEventListener("end", onAnyEvent);
        es.addEventListener("snapshot", onAnyEvent);
        es.onerror = () => {
          // Fall back to the 2s polling rate; EventSource will auto-reconnect.
          pollMs = 2000;
          startPolling();
        };
      } catch {
        // Browser doesn't support EventSource — polling carries on.
      }
    };
    setupSSE();

    return () => {
      stopped = true;
      if (pollId) clearInterval(pollId);
      es?.close();
    };
  }, []);

  const { nodes, edges } = useMemo(() => buildGraph(state), [state]);
  const { cards, log } = useFlowEvents(state);
  const survival = Boolean(state?.quota?.survival);

  return (
    <ReactFlowProvider>
      {/* Ambient radar sweep + concentric rings BEHIND the graph */}
      <div className={`radar-layer ${survival ? "red-alert" : ""}`}>
        <div className="radar-rings" />
        <div className="radar-sweep" />
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "animated",
          markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(255,255,255,0.4)" },
        }}
      >
        <Background gap={48} size={1} color="rgba(0,217,255,0.08)" />
        <Controls showInteractive={false} />

        {/* Depth vignette over the graph, under the panels */}
        <div className="hud-vignette" />

        {/* RED ALERT frame when survival mode engages */}
        {survival && <div className="red-alert-frame" />}

        {/* Top-center status strip: live clock + mode + counts */}
        <StatusStrip
          survival={survival}
          liveCount={state?.liveRuns?.length ?? 0}
          agentCount={state?.bridge.agentCount ?? 0}
          healthy={state?.bridge.healthy !== false}
        />

        {/* JARVIS narration feed — pops up when something changes */}
        <NarrationFeed cards={cards} />

        {/* Persistent terminal log (bottom-left) */}
        <ConsolePanel log={log} />

        {/* Recent-runs ticker tape (bottom, stock-ticker style) */}
        <TickerTape recent={state?.recent ?? []} />

        {state && (
          <div
            className="pointer-events-none absolute right-12 top-16 z-20 min-w-[220px] border border-hud-dim bg-black/85 px-3 py-2.5 backdrop-blur-md"
            style={{
              clipPath: "polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))",
              boxShadow: "0 0 20px rgba(0,217,255,0.15)",
            }}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[8.5px] uppercase tracking-widest text-hud glow-text">
                ◢ TELEMETRY
              </span>
              <span className="font-mono text-[8.5px] tabular text-hud-dim hud-flicker">
                {state.ts.slice(11, 19)}Z
              </span>
            </div>
            <div className="my-1.5 h-px bg-hud-dim" />
            <div className="grid grid-cols-3 gap-3 font-mono">
              <div>
                <div className="text-[8px] uppercase tracking-widest text-hud-dim">RUNS</div>
                <div className="text-base font-bold tabular text-hud glow-text">
                  {state.totals.totalRunsToday}
                </div>
              </div>
              <div>
                <div className="text-[8px] uppercase tracking-widest text-hud-dim">OK</div>
                <div className="text-base font-bold tabular text-hud glow-text">
                  {state.totals.successRate}%
                </div>
              </div>
              <div>
                <div className="text-[8px] uppercase tracking-widest text-hud-dim">SPEND</div>
                <div className="text-base font-bold tabular text-gold glow-text-gold">
                  ${state.totals.totalCostToday.toFixed(2)}
                </div>
              </div>
            </div>
            {state.recent && state.recent.length > 0 && (
              <>
                <div className="my-1.5 h-px bg-hud-dim" />
                <div className="mb-1 font-mono text-[8px] uppercase tracking-widest text-hud-dim">
                  ACTIVITY · 2H
                </div>
                <RunsSparkline recent={state.recent} />
              </>
            )}
            {state.liveRun && (
              <>
                <div className="my-1.5 h-px bg-hud-dim" />
                <div className="font-mono text-[8.5px] uppercase tracking-widest text-hud glow-text">
                  ▶ ACTIVE TARGET
                </div>
                <div className="mt-1 font-mono text-[11px] uppercase text-hud glow-text">
                  {state.liveRun.persona}
                </div>
                <div className="font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
                  {state.liveRun.cli} · {state.liveRun.model.split("/").pop()} · {state.liveRun.provider}
                </div>
              </>
            )}
            {state.quota?.survival && (
              <>
                <div className="my-1.5 h-px bg-alert-glow" />
                <div className="font-mono text-[9px] uppercase tracking-widest text-alert glow-text-alert">
                  ⚠ SURVIVAL MODE
                </div>
              </>
            )}
            {state.liveRuns && state.liveRuns.length > 1 && (
              <>
                <div className="my-1.5 h-px bg-hud-dim" />
                <div className="font-mono text-[8.5px] uppercase tracking-widest text-hud glow-text">
                  ▶ {state.liveRuns.length} CONCURRENT
                </div>
                <div className="mt-1 max-h-32 overflow-hidden font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
                  {state.liveRuns.slice(0, 6).map((r, i) => (
                    <div key={i} className="truncate">
                      {r.ticketIdentifier ?? "?"} · {r.persona} · {r.cli !== "?" ? r.cli : "wait"}
                      {r.stage ? ` · ${r.stage}` : ""}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Subtask-tree panel — only renders when the orchestrator has spawned
            child issues whose parents are visible. Shows parent ticket + which
            children are currently being worked on. */}
        {state?.tree && state.tree.length > 0 && (
          <div
            className="pointer-events-none absolute right-12 top-72 z-20 min-w-[220px] max-w-[280px] border border-hud-dim bg-black/85 px-3 py-2.5 backdrop-blur-md"
            style={{
              clipPath: "polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))",
              boxShadow: "0 0 20px rgba(0,217,255,0.15)",
            }}
          >
            <div className="font-mono text-[8.5px] uppercase tracking-widest text-hud glow-text">
              ◢ SUBTASK TREE
            </div>
            <div className="my-1.5 h-px bg-hud-dim" />
            {state.tree.map((p) => (
              <div key={p.id} className="mt-1">
                <div className="font-mono text-[10px] uppercase text-hud glow-text">
                  {p.identifier ?? p.id.slice(0, 6)} · {p.status}
                </div>
                <div className="font-mono text-[8.5px] uppercase tracking-widest text-hud-dim truncate">
                  {p.title.slice(0, 32)}
                </div>
                {p.childrenLive.length > 0 && (
                  <div className="ml-2 mt-1 font-mono text-[8.5px] uppercase tracking-widest text-hud">
                    {p.childrenLive.slice(0, 5).map((c, i) => (
                      <div key={i} className="truncate">
                        └ {c.identifier ?? "?"} · {c.persona}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ReactFlow>

      {/* Cinematic boot sequence — once per session, click to skip */}
      <BootSequence />
    </ReactFlowProvider>
  );
}

function buildGraph(s: FlowState | null): { nodes: Node[]; edges: Edge[] } {
  const active = (set: string[] | undefined, id: string) => set?.includes(id) ?? false;
  const liveRuns = s?.liveRuns ?? [];
  // Backwards-compat alias: most-recent in-flight run, used for the bottom card.
  const liveRun = s?.liveRun ?? null;
  // Operator only lights up when at least one in-flight ticket was triggered from
  // Telegram (createdByAgentId=Hermes within the last 5min). For Paperclip
  // re-dispatches it stays dim — they didn't come from a human.
  const operatorActive = Boolean(s?.operatorActive);
  // Paperclip lights up whenever ANY ticket is being worked on, regardless of
  // who triggered it.
  const paperclipLive = Boolean(s?.paperclipActive);
  // Bridge lights up while there's anything in flight at all.
  const bridgeLive = liveRuns.length > 0;
  // Hermes lights up only on Telegram-originated runs (it's the brain talking
  // to the user via Telegram or doing routing decisions). For Paperclip-dispatch
  // flows Hermes is dormant.
  const hermesLive = operatorActive;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Tier 1 — main horizontal pipeline (all aligned at CENTER_Y)
  nodes.push({
    id: "operator",
    type: "operator",
    position: { x: X.op, y: CENTER_Y },
    data: { active: operatorActive },
  });

  nodes.push({
    id: "hermes",
    type: "brain",
    position: { x: X.hermes, y: CENTER_Y },
    data: { healthy: s?.bridge.healthy, live: hermesLive },
  });

  nodes.push({
    id: "paperclip",
    type: "paperclip",
    position: { x: X.paperclip, y: CENTER_Y },
    data: { live: paperclipLive },
  });

  nodes.push({
    id: "bridge",
    type: "bridge",
    position: { x: X.bridge, y: CENTER_Y - 15 },
    data: { healthy: s?.bridge.healthy, live: bridgeLive, agentCount: s?.bridge.agentCount },
  });

  // Tier 1 edges (main pipeline)
  edges.push({
    id: "e-op-hermes",
    source: "operator",
    target: "hermes",
    type: "animated",
    data: { active: operatorActive, tone: "accent", label: operatorActive ? "telegram" : "" },
  });
  edges.push({
    id: "e-hermes-pp",
    source: "hermes",
    target: "paperclip",
    type: "animated",
    data: { active: hermesLive || paperclipLive, tone: "accent", label: "create ticket" },
  });
  edges.push({
    id: "e-pp-bridge",
    source: "paperclip",
    target: "bridge",
    type: "animated",
    data: { active: bridgeLive, tone: "live", label: "heartbeat /run" },
  });

  // Workers — light up EVERY worker that has a live run right now (not just
  // one). Multiple agents working in parallel is the normal case once the
  // orchestrator dispatches a subtask tree.
  const liveWorkerIds = new Set(liveRuns.map((r) => r.persona));
  for (const w of WORKERS) {
    const isHistoricActive = active(s?.activeWorkers, w.id);
    const isLiveNow = liveWorkerIds.has(w.id);
    const myLiveRun = liveRuns.find((r) => r.persona === w.id);
    nodes.push({
      id: `w-${w.id}`,
      type: "worker",
      position: { x: X.workers, y: w.y },
      data: {
        name: w.name,
        role: w.role,
        department: w.department,
        active: isHistoricActive || isLiveNow,
        success: undefined,
        ticket: myLiveRun?.ticketIdentifier ?? undefined,
        stage: myLiveRun?.stage ?? (isLiveNow ? "dispatched" : undefined),
      },
    });
    edges.push({
      id: `e-bridge-${w.id}`,
      source: "bridge",
      // Right-side handle so worker fan-out doesn't share the bottom services bus.
      sourceHandle: "to-workers",
      target: `w-${w.id}`,
      type: "animated",
      data: {
        active: isHistoricActive || isLiveNow,
        tone: isLiveNow ? "live" : isHistoricActive ? "accent" : "idle",
        label: isLiveNow
          ? `${myLiveRun?.ticketIdentifier ?? ""}${myLiveRun?.stage ? ` · ${myLiveRun.stage}` : ""}`
          : undefined,
      },
    });
  }

  // CLIs
  for (const c of CLIS) {
    const isActive = active(s?.activeClis, c.id === "hermes-cli" ? "hermes" : c.id);
    const cliInfo = s?.quota?.clis[c.id.replace("hermes-cli", "claude-code")];
    nodes.push({
      id: `cli-${c.id}`,
      type: "cli",
      position: { x: X.clis, y: c.y },
      data: {
        name: c.name,
        requests: cliInfo?.requests,
        available: cliInfo?.available !== false,
        active: isActive,
      },
    });
  }

  // Worker → CLI edges — one per live run. Multiple agents on claude render
  // as multiple animated edges instead of one shared line.
  for (const r of liveRuns) {
    if (r.cli === "?" || !r.cli) continue;
    const wid = `w-${r.persona}`;
    const cid = `cli-${r.cli === "hermes" ? "hermes-cli" : r.cli}`;
    if (nodes.find((n) => n.id === wid) && nodes.find((n) => n.id === cid)) {
      edges.push({
        id: `e-live-${wid}-${cid}-${r.ticketIdentifier ?? r.ticketId ?? "?"}`,
        source: wid,
        target: cid,
        type: "animated",
        data: { active: true, tone: "live", label: r.model && r.model !== "?" ? r.model.split("/").pop() : undefined },
      });
    }
  }
  // Every worker can reach every CLI thanks to the fallback chain (registry
  // says preferred + 4 fallbacks per agent, and at least one of them touches
  // each CLI). Draw faded idle edges from each worker to EVERY CLI so the
  // topology is honest — a live edge from the loop above will overlay this
  // one with bright colour when that worker is actually using that CLI.
  const ALL_CLIS = ["claude", "codex", "agy", "opencode"];
  for (const w of WORKERS) {
    for (const c of ALL_CLIS) {
      const wid = `w-${w.id}`;
      const cid = `cli-${c}`;
      const id = `e-idle-${wid}-${cid}`;
      const hasLiveOverlay = edges.some(
        (e) => e.source === wid && e.target === cid && e.data?.tone === "live",
      );
      if (!edges.find((e) => e.id === id) && !hasLiveOverlay) {
        edges.push({
          id,
          source: wid,
          target: cid,
          type: "animated",
          data: { active: false, tone: "idle" },
        });
      }
    }
  }

  // Providers
  for (const p of PROVIDERS) {
    const pinfo = s?.quota?.providers[p.id];
    const isActive = active(s?.activeProviders, p.id);
    nodes.push({
      id: `p-${p.id}`,
      type: "provider",
      position: { x: X.providers, y: p.y },
      data: {
        name: p.name,
        pct: pinfo?.pct,
        requests: pinfo?.requests,
        available: pinfo?.available !== false,
        active: isActive,
        critical: p.id === s?.quota?.critical,
      },
    });
  }

  // CLI → Provider edges
  for (const c of CLIS) {
    const cliKey = c.id === "hermes-cli" ? "hermes" : c.id;
    const cliActive = active(s?.activeClis, cliKey);
    const providers = CLI_TO_PROVIDER[c.id] ?? [];
    for (const prov of providers) {
      const isHotEdge = cliActive && liveRun?.provider === prov;
      edges.push({
        id: `e-cli-${c.id}-p-${prov}`,
        source: `cli-${c.id}`,
        target: `p-${prov}`,
        type: "animated",
        data: {
          active: isHotEdge,
          tone: isHotEdge ? "live" : "idle",
        },
      });
    }
  }

  // Side services — each one lights up ONLY when its real signal fires.
  // (Before: every service glowed in lockstep with any in-flight run, which
  // overstated actual activity. Now we use activeServices flags from the API.)
  const services = s?.activeServices;
  const sy = CENTER_Y + 380;
  const svDefs = [
    {
      id: "quota",
      name: "Quota",
      port: 7001,
      icon: "gauge" as const,
      x: 280,
      y: sy,
      detail: s?.quota?.survival ? "survival ⚠" : "ok",
      live: Boolean(services?.quota),
    },
    {
      id: "policy",
      name: "Policy",
      port: 7002,
      icon: "shield" as const,
      x: 510,
      y: sy,
      detail: "5 rules",
      live: Boolean(services?.policy),
    },
    {
      id: "memory",
      name: "Memory",
      port: 6333,
      icon: "database" as const,
      x: 740,
      y: sy + 30,
      detail: "qdrant · 4 scopes",
      live: Boolean(services?.memory),
    },
    {
      id: "learning",
      name: "Learning",
      port: 7003,
      icon: "sparkles" as const,
      x: 970,
      y: sy,
      detail: "outcomes →",
      live: Boolean(services?.learning),
    },
    {
      id: "gateway",
      name: "Tool Gateway",
      port: 7004,
      icon: "wrench" as const,
      x: 1200,
      y: sy,
      detail: s?.recentToolCalls?.length ? `${s.recentToolCalls.length} calls` : "idle",
      live: Boolean(services?.gateway),
    },
  ];
  for (const sv of svDefs) {
    nodes.push({
      id: `s-${sv.id}`,
      type: "service",
      position: { x: sv.x, y: sv.y },
      data: { name: sv.name, port: sv.port, icon: sv.icon, healthy: true, live: sv.live, detail: sv.detail },
    });
    edges.push({
      id: `e-bridge-s-${sv.id}`,
      source: "bridge",
      // Bridge has two source handles: "to-workers" (right) and "to-services"
      // (bottom). Services go through the bottom one so the cables don't tangle
      // with the worker fan-out on the right side.
      sourceHandle: "to-services",
      target: `s-${sv.id}`,
      type: "animated",
      data: { active: sv.live, tone: sv.live ? "live" : "idle" },
    });
  }

  // Learning → Quota feedback loop (smart routing)
  edges.push({
    id: "e-learning-quota",
    source: "s-learning",
    target: "s-quota",
    type: "animated",
    data: { active: true, tone: "accent", label: "smart-route" },
  });

  return { nodes, edges };
}
