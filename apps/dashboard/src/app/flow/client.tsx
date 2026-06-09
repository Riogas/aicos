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
  recentToolCalls: Array<{ ts: string; tool: string; actor: string; action: string; decision: string }>;
  totals: { totalRunsToday: number; successRate: number; totalCostToday: number };
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
    const tick = async () => {
      try {
        const r = await fetch("/api/flow-state", { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as FlowState;
        if (!stopped) setState(data);
      } catch {
        /* noop */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const { nodes, edges } = useMemo(() => buildGraph(state), [state]);

  return (
    <ReactFlowProvider>
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
          </div>
        )}
      </ReactFlow>
    </ReactFlowProvider>
  );
}

function buildGraph(s: FlowState | null): { nodes: Node[]; edges: Edge[] } {
  const active = (set: string[] | undefined, id: string) => set?.includes(id) ?? false;
  const liveRun = s?.liveRun;
  const hermesLive = false; // can't detect directly today
  const operatorActive = Boolean(liveRun);
  const paperclipLive = Boolean(liveRun?.ticketId);
  const bridgeLive = Boolean(liveRun);

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

  // Workers
  for (const w of WORKERS) {
    const isActive = active(s?.activeWorkers, w.id);
    const isLiveRunWorker = liveRun?.persona === w.id;
    nodes.push({
      id: `w-${w.id}`,
      type: "worker",
      position: { x: X.workers, y: w.y },
      data: {
        name: w.name,
        role: w.role,
        department: w.department,
        active: isActive || isLiveRunWorker,
        success: isLiveRunWorker ? liveRun?.success : undefined,
      },
    });
    edges.push({
      id: `e-bridge-${w.id}`,
      source: "bridge",
      target: `w-${w.id}`,
      type: "animated",
      data: { active: isActive || isLiveRunWorker, tone: isLiveRunWorker ? "live" : "idle" },
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

  // Worker → CLI edges (which CLI each worker tends to use)
  // For simplicity, we draw an edge from every active worker to the CLI used in the liveRun
  if (liveRun) {
    const wid = `w-${liveRun.persona}`;
    const cid = `cli-${liveRun.cli === "hermes" ? "hermes-cli" : liveRun.cli}`;
    if (nodes.find((n) => n.id === wid) && nodes.find((n) => n.id === cid)) {
      edges.push({
        id: `e-${wid}-${cid}`,
        source: wid,
        target: cid,
        type: "animated",
        data: { active: true, tone: "live", label: liveRun.model.split("/").pop() },
      });
    }
  }
  // Static greyed-out edges from all workers to their canonical first CLI choice
  // (so the topology is visible even when idle)
  const idlePairs: Array<[string, string]> = [
    ["w-it-analyst", "cli-claude"],
    ["w-it-architect", "cli-claude"],
    ["w-it-implementer", "cli-codex"],
    ["w-it-code-reviewer", "cli-claude"],
    ["w-it-security-reviewer", "cli-claude"],
    ["w-it-documenter", "cli-agy"],
    ["w-it-ui-ux-validator", "cli-claude"],
    ["w-marketing-strategist", "cli-claude"],
    ["w-marketing-copywriter", "cli-codex"],
    ["w-research-market", "cli-opencode"],
  ];
  for (const [w, c] of idlePairs) {
    const id = `e-idle-${w}-${c}`;
    if (!edges.find((e) => e.source === w && e.target === c)) {
      edges.push({
        id,
        source: w,
        target: c,
        type: "animated",
        data: { active: false, tone: "idle" },
      });
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

  // Side services — arranged in an arc below the Bridge (arc-reactor satellites)
  const bx = X.bridge + 65; // bridge center X (130/2)
  const by = CENTER_Y + 215; // services row Y
  const services = [
    { id: "quota", name: "Quota", port: 7001, icon: "gauge" as const, x: bx - 380, y: by - 30, detail: s?.quota?.survival ? "survival ⚠" : "ok" },
    { id: "policy", name: "Policy", port: 7002, icon: "shield" as const, x: bx - 190, y: by + 20, detail: "5 rules" },
    { id: "memory", name: "Memory", port: 6333, icon: "database" as const, x: bx - 75, y: by + 60, detail: "qdrant · 4 scopes" },
    { id: "learning", name: "Learning", port: 7003, icon: "sparkles" as const, x: bx + 105, y: by + 20, detail: "outcomes →" },
    { id: "gateway", name: "Tool Gateway", port: 7004, icon: "wrench" as const, x: bx + 270, y: by - 30, detail: s?.recentToolCalls?.length ? `${s.recentToolCalls.length} calls` : "idle" },
  ];
  for (const sv of services) {
    nodes.push({
      id: `s-${sv.id}`,
      type: "service",
      position: { x: sv.x, y: sv.y },
      data: { name: sv.name, port: sv.port, icon: sv.icon, healthy: true, live: bridgeLive, detail: sv.detail },
    });
    edges.push({
      id: `e-bridge-s-${sv.id}`,
      source: "bridge",
      target: `s-${sv.id}`,
      type: "animated",
      data: { active: bridgeLive, tone: bridgeLive ? "live" : "idle" },
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
