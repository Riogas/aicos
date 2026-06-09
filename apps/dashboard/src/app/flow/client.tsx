"use client";

import "@xyflow/react/dist/style.css";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
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

// Layout constants
const X = { op: 0, hermes: 240, paperclip: 480, bridge: 760, workers: 1040, clis: 1320, providers: 1560 };
const SIDE_Y = 720; // services row

const WORKERS = [
  // IT — top group
  { id: "it-analyst", name: "IT Analyst", role: "analyst", department: "IT", y: 60 },
  { id: "it-architect", name: "IT Architect", role: "architect", department: "IT", y: 130 },
  { id: "it-implementer", name: "IT Implementer", role: "impl", department: "IT", y: 200 },
  { id: "it-code-reviewer", name: "Code Reviewer", role: "review", department: "IT", y: 270 },
  { id: "it-security-reviewer", name: "Security Rev", role: "security", department: "IT", y: 340 },
  { id: "it-documenter", name: "IT Documenter", role: "docs", department: "IT", y: 410 },
  { id: "it-ui-ux-validator", name: "UX Validator", role: "ux", department: "IT", y: 480 },
  // marketing
  { id: "marketing-strategist", name: "MK Strategist", role: "strategy", department: "MK", y: 550 },
  { id: "marketing-copywriter", name: "Copywriter", role: "copy", department: "MK", y: 620 },
  // research
  { id: "research-market", name: "Market Analyst", role: "research", department: "RX", y: 690 },
];

const CLIS = [
  { id: "claude", name: "claude", y: 100 },
  { id: "codex", name: "codex", y: 220 },
  { id: "agy", name: "agy", y: 340 },
  { id: "opencode", name: "opencode", y: 460 },
  { id: "hermes-cli", name: "hermes", y: 580 },
];

const CLI_TO_PROVIDER: Record<string, string[]> = {
  claude: ["anthropic"],
  codex: ["openai"],
  agy: ["google"],
  opencode: ["moonshot", "xiaomi", "opencode-free"],
  "hermes-cli": ["openai", "anthropic", "google"],
};

const PROVIDERS = [
  { id: "anthropic", name: "anthropic", y: 100 },
  { id: "openai", name: "openai", y: 220 },
  { id: "google", name: "google", y: 340 },
  { id: "moonshot", name: "moonshot", y: 460 },
  { id: "xiaomi", name: "xiaomi", y: 540 },
  { id: "opencode-free", name: "opencode-free", y: 620 },
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
        <Background gap={32} size={1} color="rgba(255,255,255,0.04)" />
        <Controls
          showInteractive={false}
          className="!rounded-md !border !border-border !bg-surface !text-fg"
        />
        <MiniMap
          pannable
          zoomable
          className="!rounded-md !border !border-border !bg-surface"
          nodeColor={(n) => (n.data as { active?: boolean })?.active ? "#3b82f6" : "#525252"}
        />

        {state && (
          <div className="pointer-events-none absolute right-4 top-4 z-10 rounded-lg border border-border bg-surface/90 px-3 py-2 backdrop-blur-md">
            <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">
              live · {state.ts.slice(11, 19)}Z
            </div>
            <div className="mt-1 grid grid-cols-3 gap-3 font-mono text-xs">
              <div>
                <div className="text-subtle">runs</div>
                <div className="text-fg">{state.totals.totalRunsToday}</div>
              </div>
              <div>
                <div className="text-subtle">success</div>
                <div className="text-fg">{state.totals.successRate}%</div>
              </div>
              <div>
                <div className="text-subtle">spend</div>
                <div className="text-fg">${state.totals.totalCostToday.toFixed(3)}</div>
              </div>
            </div>
            {state.liveRun && (
              <div className="mt-2 border-t border-border pt-2">
                <div className="font-mono text-2xs uppercase tracking-tightest text-accent">▶ live</div>
                <div className="mt-0.5 text-xs text-fg">{state.liveRun.persona}</div>
                <div className="font-mono text-2xs text-subtle">{state.liveRun.cli}/{state.liveRun.model.split("/").pop()}</div>
              </div>
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

  // Tier 1 — main vertical pipeline
  nodes.push({
    id: "operator",
    type: "operator",
    position: { x: X.op, y: 340 },
    data: { active: operatorActive },
  });

  nodes.push({
    id: "hermes",
    type: "brain",
    position: { x: X.hermes, y: 340 },
    data: { healthy: s?.bridge.healthy, live: hermesLive },
  });

  nodes.push({
    id: "paperclip",
    type: "paperclip",
    position: { x: X.paperclip, y: 340 },
    data: { live: paperclipLive },
  });

  nodes.push({
    id: "bridge",
    type: "bridge",
    position: { x: X.bridge, y: 340 },
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

  // Side services (Quota, Learning, Policy, ToolGateway, Memory) — below the bridge
  const services = [
    { id: "quota", name: "Quota", port: 7001, icon: "gauge" as const, x: X.bridge - 200, detail: s?.quota?.survival ? "survival ⚠" : "ok" },
    { id: "policy", name: "Policy", port: 7002, icon: "shield" as const, x: X.bridge - 60, detail: "5 rules" },
    { id: "learning", name: "Learning", port: 7003, icon: "sparkles" as const, x: X.bridge + 80, detail: "outcomes →" },
    { id: "gateway", name: "Tool Gateway", port: 7004, icon: "wrench" as const, x: X.bridge + 220, detail: s?.recentToolCalls?.length ? `${s.recentToolCalls.length} calls` : "idle" },
    { id: "memory", name: "Memory", port: 6333, icon: "database" as const, x: X.bridge + 360, detail: "qdrant · 4 scopes" },
  ];
  for (const sv of services) {
    nodes.push({
      id: `s-${sv.id}`,
      type: "service",
      position: { x: sv.x, y: SIDE_Y },
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
