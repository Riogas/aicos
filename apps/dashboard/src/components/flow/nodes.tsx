"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
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

/* ───────────────────────────────────────────────────────────────
   Cut-corner rectangle (octagonal) shell — sci-fi tech panel.
   Way more room for text than a hexagon.
─────────────────────────────────────────────────────────────── */
function HexShell({
  width = 200,
  height = 64,
  tone = "idle",
  live = false,
  critical = false,
  children,
}: {
  width?: number;
  height?: number;
  tone?: Tone;
  live?: boolean;
  critical?: boolean;
  children: React.ReactNode;
}) {
  const toneColor =
    tone === "live"
      ? "#00d9ff"
      : tone === "warn"
        ? "#fbbf24"
        : tone === "err"
          ? "#ff3b30"
          : tone === "ok"
            ? "#22c55e"
            : tone === "accent"
              ? "#a855f7"
              : "rgba(0,217,255,0.4)";
  const innerOpacity = live ? 0.18 : critical ? 0.10 : 0.05;
  const glow = live
    ? `drop-shadow(0 0 10px ${toneColor}) drop-shadow(0 0 22px ${toneColor})`
    : critical
      ? `drop-shadow(0 0 6px ${toneColor})`
      : "none";
  const gradId = `cc-${tone}-${live ? "1" : "0"}-${critical ? "c" : "x"}`;
  const cc = 10; // corner cut

  const points = [
    [cc, 0],
    [width - cc, 0],
    [width, cc],
    [width, height - cc],
    [width - cc, height],
    [cc, height],
    [0, height - cc],
    [0, cc],
  ];
  const pointStr = points.map((p) => p.join(",")).join(" ");

  const innerOff = 3.5;
  const innerPoints = [
    [cc + innerOff * 0.7, innerOff],
    [width - cc - innerOff * 0.7, innerOff],
    [width - innerOff, cc + innerOff * 0.7],
    [width - innerOff, height - cc - innerOff * 0.7],
    [width - cc - innerOff * 0.7, height - innerOff],
    [cc + innerOff * 0.7, height - innerOff],
    [innerOff, height - cc - innerOff * 0.7],
    [innerOff, cc + innerOff * 0.7],
  ];
  const innerStr = innerPoints.map((p) => p.join(",")).join(" ");

  return (
    <div
      style={{ width, height, filter: glow }}
      className={`relative ${live ? "target-lock" : ""}`}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0 }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={toneColor} stopOpacity={innerOpacity + 0.05} />
            <stop offset="100%" stopColor="#000" stopOpacity={innerOpacity} />
          </linearGradient>
        </defs>
        <polygon
          points={pointStr}
          fill={`url(#${gradId})`}
          stroke={toneColor}
          strokeWidth={live ? 1.4 : 0.9}
          opacity={live ? 1 : 0.75}
        />
        <polygon
          points={innerStr}
          fill="none"
          stroke={toneColor}
          strokeWidth={0.5}
          opacity={live ? 0.45 : 0.18}
        />
        {/* Side accent ticks */}
        <line x1={2} y1={height * 0.3} x2={2} y2={height * 0.7} stroke={toneColor} strokeWidth={1.5} opacity={live ? 1 : 0.7} />
        <line x1={width - 2} y1={height * 0.3} x2={width - 2} y2={height * 0.7} stroke={toneColor} strokeWidth={1.5} opacity={live ? 1 : 0.7} />
      </svg>

      {live && (
        <>
          <span className="hud-bracket tl" />
          <span className="hud-bracket tr" />
          <span className="hud-bracket bl" />
          <span className="hud-bracket br" />
        </>
      )}

      <div className="relative z-10 flex h-full items-center px-4">{children}</div>
    </div>
  );
}

const TONE_TEXT: Record<Tone, string> = {
  idle: "text-hud-dim",
  live: "text-hud glow-text",
  warn: "text-warning",
  ok: "text-success",
  err: "text-alert glow-text-alert",
  accent: "text-violet",
};

function NodeBody({
  icon: Icon,
  title,
  subtitle,
  tone,
  detail,
}: {
  icon: React.ElementType;
  title: string;
  subtitle?: string;
  tone: Tone;
  detail?: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-2.5">
      <div
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-sm border ${tone === "live" ? "border-hud" : "border-hud-dim"} bg-black/40`}
      >
        <Icon className={`h-3.5 w-3.5 ${TONE_TEXT[tone]}`} strokeWidth={2} />
      </div>
      <div className="flex min-w-0 flex-col">
        <span className={`truncate font-mono text-[11px] uppercase tracking-wider ${TONE_TEXT[tone]}`}>
          {title}
        </span>
        {subtitle && (
          <span className="truncate font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
            {subtitle}
          </span>
        )}
        {detail && <div className="mt-0.5 font-mono text-[9px] text-hud-dim">{detail}</div>}
      </div>
    </div>
  );
}

function HandleStyled({
  position,
  type,
  id,
}: {
  position: Position;
  type: "source" | "target";
  id?: string;
}) {
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      className="!h-1.5 !w-1.5 !border-0 !bg-hud"
      style={{ boxShadow: "0 0 4px rgba(0,217,255,0.9)" }}
    />
  );
}

/* ─── Node components ─────────────────────────────────────────── */

export function OperatorNode({ data }: NodeProps) {
  const d = data as { active?: boolean };
  const tone: Tone = d.active ? "live" : "idle";
  return (
    <>
      <HexShell tone={tone} live={d.active} width={170} height={62}>
        <NodeBody icon={User} title="OPERATOR" subtitle="HUMAN · TELEGRAM" tone={tone} />
      </HexShell>
      <HandleStyled type="source" position={Position.Right} />
    </>
  );
}

export function BrainNode({ data }: NodeProps) {
  const d = data as { healthy?: boolean; live?: boolean };
  const tone: Tone = d.live ? "live" : d.healthy ? "ok" : "err";
  const segments = d.healthy ? 8 : 2;
  return (
    <>
      <HexShell tone={tone} live={d.live} width={200} height={62}>
        <NodeBody
          icon={Brain}
          title="HERMES · BRAIN"
          subtitle="OAUTH · CODEX"
          tone={tone}
          detail={
            <span className="segment-bar">
              {Array.from({ length: 8 }).map((_, i) => (
                <span key={i} className={i < segments ? "on" : ""} />
              ))}
            </span>
          }
        />
      </HexShell>
      <HandleStyled type="target" position={Position.Left} />
      <HandleStyled type="source" position={Position.Right} />
    </>
  );
}

export function PaperclipNode({ data }: NodeProps) {
  const d = data as { live?: boolean };
  const tone: Tone = d.live ? "live" : "ok";
  return (
    <>
      <HexShell tone={tone} live={d.live} width={190} height={62}>
        <NodeBody icon={Workflow} title="PAPERCLIP" subtitle=":3100 · BOARD" tone={tone} detail="WORK QUEUE" />
      </HexShell>
      <HandleStyled type="target" position={Position.Left} />
      <HandleStyled type="source" position={Position.Right} />
    </>
  );
}

/**
 * BRIDGE — the ARC REACTOR. Circular, multi-ring, central.
 */
export function BridgeNode({ data }: NodeProps) {
  const d = data as { healthy?: boolean; live?: boolean; agentCount?: number };
  const color = d.live ? "#00d9ff" : d.healthy ? "#00d9ff" : "#ff3b30";
  const size = 130;
  return (
    <div className={`relative ${d.live ? "reactor-beat" : ""}`} style={{ width: size, height: size }}>
      {/* Outer rotating ring with notches — fast when live */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        className={`absolute inset-0 ${d.live ? "spin-fast" : "spin-slow"}`}
        style={{ filter: `drop-shadow(0 0 ${d.live ? 14 : 8}px ${color})` }}
      >
        <circle cx="50" cy="50" r="48" fill="none" stroke={color} strokeWidth="0.6" strokeDasharray="2 4" opacity="0.6" />
        {Array.from({ length: 12 }).map((_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          const x1 = 50 + 46 * Math.cos(a);
          const y1 = 50 + 46 * Math.sin(a);
          const x2 = 50 + 48 * Math.cos(a);
          const y2 = 50 + 48 * Math.sin(a);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="1" />;
        })}
      </svg>
      {/* Counter-rotating mid ring — fast when live */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        className={`absolute inset-0 ${d.live ? "spin-fast-rev" : "spin-slow-rev"}`}
      >
        <circle cx="50" cy="50" r="38" fill="none" stroke={color} strokeWidth="0.4" strokeDasharray="8 6" opacity="0.5" />
      </svg>
      {/* Inner solid ring */}
      <svg width={size} height={size} viewBox="0 0 100 100" className="absolute inset-0">
        <circle cx="50" cy="50" r="32" fill={color} fillOpacity="0.08" stroke={color} strokeWidth="0.8" opacity="0.9" />
        <circle cx="50" cy="50" r="22" fill="black" stroke={color} strokeWidth="0.6" opacity="0.7" />
        {/* Arc reactor central glyph */}
        <circle cx="50" cy="50" r="6" fill={color} opacity={d.live ? "1" : "0.7"} style={{ filter: `drop-shadow(0 0 6px ${color})` }}>
          {d.live && <animate attributeName="opacity" values="0.6;1;0.6" dur="1.4s" repeatCount="indefinite" />}
        </circle>
      </svg>
      {/* Concentric pulse rings when active */}
      {d.live && (
        <>
          <div className="arc-ring d-0" style={{ borderColor: color }} />
          <div className="arc-ring d-1" style={{ borderColor: color }} />
          <div className="arc-ring d-2" style={{ borderColor: color }} />
          {/* Wide sonar sweep — big ripples when live */}
          <div className="arc-sonar d-0" style={{ borderColor: color }} />
          <div className="arc-sonar d-1" style={{ borderColor: color }} />
        </>
      )}
      {/* Center label */}
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-0.5">
          <Network className="h-3 w-3 text-hud" strokeWidth={2.2} />
          <span className="font-mono text-[8.5px] uppercase tracking-widest text-hud glow-text">BRIDGE</span>
          <span className="font-mono text-[7px] uppercase tracking-widest text-hud-dim">{d.agentCount ?? 0} AG</span>
        </div>
      </div>
      <HandleStyled type="target" position={Position.Left} />
      {/* Named handles so edges can pick which side they leave from. */}
      <HandleStyled type="source" position={Position.Right} id="to-workers" />
      <HandleStyled type="source" position={Position.Bottom} id="to-services" />
    </div>
  );
}

export function WorkerNode({ data }: NodeProps) {
  const d = data as { name: string; role: string; department: string; active?: boolean; success?: boolean };
  const tone: Tone = d.active ? "live" : d.success === false ? "err" : "idle";
  return (
    <>
      <HexShell tone={tone} live={d.active} width={196} height={54}>
        <NodeBody
          icon={Sparkles}
          title={d.name.toUpperCase()}
          subtitle={`${d.department} · ${d.role}`}
          tone={tone}
        />
      </HexShell>
      <HandleStyled type="target" position={Position.Left} />
      <HandleStyled type="source" position={Position.Right} />
    </>
  );
}

export function CliNode({ data }: NodeProps) {
  const d = data as { name: string; requests?: number; maxRequests?: number; available?: boolean; active?: boolean };
  const tone: Tone = d.active ? "live" : d.available === false ? "err" : "idle";
  return (
    <>
      <HexShell tone={tone} live={d.active} width={150} height={54}>
        <NodeBody
          icon={Terminal}
          title={d.name.toUpperCase()}
          subtitle="CLI"
          tone={tone}
          detail={d.requests != null ? `${d.requests}${d.maxRequests ? `/${d.maxRequests}` : ""} REQ` : undefined}
        />
      </HexShell>
      <HandleStyled type="target" position={Position.Left} />
      <HandleStyled type="source" position={Position.Right} />
    </>
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
  const tone: Tone = !d.available ? "err" : (d.pct ?? 0) >= 80 ? "warn" : d.active ? "live" : d.critical ? "accent" : "idle";
  const pct = Math.round(d.pct ?? 0);
  // Tooltip clarifies that the bar is a LOCAL counter, not the real session
  // usage exposed by the provider's web UI / interactive CLI commands.
  const tooltip = `Local Quota Manager budget — NOT real provider session usage.\nFor Anthropic Max-Plan, run /usage inside Claude Code to see real session %.\nFor pay-as-you-go API keys, configure LiteLLM and point the bridge at it.`;
  return (
    <>
      <HexShell tone={tone} live={d.active} critical={d.critical} width={180} height={58}>
        <NodeBody
          icon={Cpu}
          title={d.name.toUpperCase()}
          subtitle={d.critical ? "CRITICAL · LOCAL" : "PROVIDER · LOCAL"}
          tone={tone}
          detail={
            <div className="flex items-center gap-1.5" title={tooltip}>
              <span>{d.requests ?? 0}R</span>
              <div className="h-0.5 w-10 overflow-hidden bg-hud-soft">
                <div
                  className={`h-full ${(d.pct ?? 0) >= 80 ? "bg-warning" : "bg-hud"}`}
                  style={{ width: `${pct}%`, boxShadow: "0 0 4px rgba(0,217,255,0.8)" }}
                />
              </div>
              <span>{pct}%</span>
            </div>
          }
        />
      </HexShell>
      <HandleStyled type="target" position={Position.Left} />
    </>
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
  const tone: Tone = d.live ? "live" : d.healthy === false ? "err" : "ok";
  return (
    <>
      <HexShell tone={tone} live={d.live} width={180} height={58}>
        <NodeBody
          icon={Icon}
          title={d.name.toUpperCase()}
          subtitle={`:${d.port}`}
          tone={tone}
          detail={d.detail}
        />
      </HexShell>
      <HandleStyled type="target" position={Position.Top} />
    </>
  );
}
