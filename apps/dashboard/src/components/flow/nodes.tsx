"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { motion } from "framer-motion";
import {
  Activity,
  Brain,
  Cpu,
  Database,
  Gauge,
  Network,
  ShieldCheck,
  Sparkles,
  Terminal,
  User,
  Workflow,
  Wrench,
} from "lucide-react";

type Tone = "idle" | "live" | "warn" | "ok" | "err" | "accent";

const TONE_RING: Record<Tone, string> = {
  idle: "ring-white/10",
  live: "ring-accent/60",
  warn: "ring-warning/60",
  ok: "ring-success/60",
  err: "ring-danger/60",
  accent: "ring-violet/60",
};
const TONE_GLOW: Record<Tone, string> = {
  idle: "shadow-[0_0_0_0_rgba(0,0,0,0)]",
  live: "shadow-[0_0_36px_0_rgba(59,130,246,0.35)]",
  warn: "shadow-[0_0_36px_0_rgba(245,158,11,0.35)]",
  ok: "shadow-[0_0_24px_0_rgba(34,197,94,0.30)]",
  err: "shadow-[0_0_36px_0_rgba(239,68,68,0.35)]",
  accent: "shadow-[0_0_36px_0_rgba(168,85,247,0.35)]",
};
const TONE_TEXT: Record<Tone, string> = {
  idle: "text-muted",
  live: "text-accent",
  warn: "text-warning",
  ok: "text-success",
  err: "text-danger",
  accent: "text-violet",
};

function NodeShell({
  icon: Icon,
  title,
  subtitle,
  tone = "idle",
  live = false,
  topHandle = false,
  bottomHandle = false,
  leftHandle = true,
  rightHandle = true,
  children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle?: string;
  tone?: Tone;
  live?: boolean;
  topHandle?: boolean;
  bottomHandle?: boolean;
  leftHandle?: boolean;
  rightHandle?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className={`relative rounded-xl border bg-surface bg-card-bevel ring-1 transition-all duration-300 ${TONE_RING[tone]} ${TONE_GLOW[tone]} px-3 py-2 min-w-[140px]`}
    >
      {live && (
        <motion.span
          className="absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-accent"
          animate={{ scale: [1, 1.6, 1], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      {leftHandle && <Handle type="target" position={Position.Left} className="!h-2 !w-2 !bg-border" />}
      {topHandle && <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-border" />}
      {rightHandle && <Handle type="source" position={Position.Right} className="!h-2 !w-2 !bg-border" />}
      {bottomHandle && <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-border" />}

      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 ${TONE_TEXT[tone]}`} strokeWidth={2} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[11px] font-semibold tracking-tight text-fg">{title}</span>
          {subtitle && (
            <span className="truncate font-mono text-[9px] uppercase tracking-tightest text-subtle">{subtitle}</span>
          )}
        </div>
      </div>
      {children && <div className="mt-1.5 text-[10px] text-muted">{children}</div>}
    </motion.div>
  );
}

export function OperatorNode({ data }: NodeProps) {
  return (
    <NodeShell
      icon={User}
      title="Operator"
      subtitle="you / telegram"
      tone={(data as { active?: boolean })?.active ? "accent" : "idle"}
      live={(data as { active?: boolean })?.active}
      leftHandle={false}
    />
  );
}

export function BrainNode({ data }: NodeProps) {
  const d = data as { healthy?: boolean; live?: boolean };
  return (
    <NodeShell
      icon={Brain}
      title="Hermes"
      subtitle="brain · codex"
      tone={d.live ? "accent" : d.healthy ? "ok" : "err"}
      live={d.live}
    >
      <div className="font-mono text-[10px] text-subtle">via OAuth</div>
    </NodeShell>
  );
}

export function PaperclipNode({ data }: NodeProps) {
  const d = data as { activeIssues?: number; live?: boolean };
  return (
    <NodeShell
      icon={Workflow}
      title="Paperclip"
      subtitle=":3100 · board"
      tone={d.live ? "live" : "ok"}
      live={d.live}
    >
      {d.activeIssues != null && (
        <span className="font-mono">{d.activeIssues} tickets activos</span>
      )}
    </NodeShell>
  );
}

export function BridgeNode({ data }: NodeProps) {
  const d = data as { healthy?: boolean; live?: boolean; agentCount?: number };
  return (
    <NodeShell
      icon={Network}
      title="Bridge"
      subtitle=":7100 · orchestrator"
      tone={d.live ? "live" : d.healthy ? "ok" : "err"}
      live={d.live}
    >
      <div className="font-mono">{d.agentCount ?? 0} agents resolvable</div>
    </NodeShell>
  );
}

export function WorkerNode({ data }: NodeProps) {
  const d = data as {
    name: string;
    role: string;
    department: string;
    active?: boolean;
    success?: boolean;
  };
  const tone: Tone = d.active ? "live" : d.success === false ? "err" : "idle";
  return (
    <NodeShell
      icon={Sparkles}
      title={d.name}
      subtitle={d.role}
      tone={tone}
      live={d.active}
    >
      <span className="font-mono text-[9px] text-subtle">{d.department}</span>
    </NodeShell>
  );
}

export function CliNode({ data }: NodeProps) {
  const d = data as {
    name: string;
    requests?: number;
    maxRequests?: number;
    available?: boolean;
    active?: boolean;
  };
  const tone: Tone = d.active
    ? "live"
    : d.available === false
      ? "err"
      : "idle";
  return (
    <NodeShell
      icon={Terminal}
      title={d.name}
      subtitle="CLI worker"
      tone={tone}
      live={d.active}
      rightHandle={false}
    >
      {d.maxRequests != null && (
        <div className="font-mono text-[10px]">
          {d.requests ?? 0}/{d.maxRequests}r
        </div>
      )}
    </NodeShell>
  );
}

export function ProviderNode({ data }: NodeProps) {
  const d = data as {
    name: string;
    pct?: number;
    requests?: number;
    available?: boolean;
    active?: boolean;
    critical?: boolean;
  };
  const tone: Tone = !d.available
    ? "err"
    : (d.pct ?? 0) >= 80
      ? "warn"
      : d.active
        ? "live"
        : d.critical
          ? "accent"
          : "idle";
  return (
    <NodeShell
      icon={Cpu}
      title={d.name}
      subtitle={d.critical ? "critical" : "provider"}
      tone={tone}
      live={d.active}
      rightHandle={false}
    >
      <div className="flex items-center gap-1.5 font-mono text-[10px]">
        <span>{d.requests ?? 0}r</span>
        <div className="h-1 w-12 overflow-hidden rounded-full bg-surface-3">
          <div
            className={`h-full rounded-full ${
              (d.pct ?? 0) >= 80 ? "bg-warning" : "bg-accent"
            }`}
            style={{ width: `${d.pct ?? 0}%` }}
          />
        </div>
      </div>
    </NodeShell>
  );
}

export function ServiceNode({ data }: NodeProps) {
  const d = data as {
    name: string;
    port: number;
    icon?: "gauge" | "sparkles" | "shield" | "database" | "wrench" | "activity";
    healthy?: boolean;
    live?: boolean;
    detail?: string;
  };
  const iconMap = {
    gauge: Gauge,
    sparkles: Sparkles,
    shield: ShieldCheck,
    database: Database,
    wrench: Wrench,
    activity: Activity,
  };
  const Icon = iconMap[d.icon ?? "activity"];
  return (
    <NodeShell
      icon={Icon}
      title={d.name}
      subtitle={`:${d.port}`}
      tone={d.live ? "live" : d.healthy === false ? "err" : "ok"}
      live={d.live}
      topHandle
    >
      {d.detail && <span className="font-mono text-[10px] text-subtle">{d.detail}</span>}
    </NodeShell>
  );
}
