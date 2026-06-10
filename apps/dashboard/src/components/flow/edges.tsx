"use client";

import { type EdgeProps, getBezierPath, BaseEdge, EdgeLabelRenderer } from "@xyflow/react";

interface AnimatedEdgeData {
  active?: boolean;
  tone?: "idle" | "live" | "warn" | "err" | "accent";
  label?: string;
}

export function AnimatedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const d = (data as unknown as AnimatedEdgeData) ?? {};

  const colorMap = {
    idle: "rgba(0,217,255,0.18)",
    live: "#00d9ff",
    warn: "#fbbf24",
    err: "#ff3b30",
    accent: "#a855f7",
  };
  const tone = d.tone ?? (d.active ? "live" : "idle");
  const c = colorMap[tone];
  const duration = tone === "accent" ? "3.2s" : "1.6s";

  return (
    <>
      {/* Idle edges: cheap CSS dash-flow (the old per-edge SVG particle put
          ~40 animateMotion loops on screen permanently). Live edges keep the
          hot multi-particle beam. */}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={!d.active ? "edge-idle-flow" : undefined}
        style={{
          stroke: c,
          strokeWidth: d.active ? 2 : 1,
          filter: d.active ? `drop-shadow(0 0 6px ${c}) drop-shadow(0 0 14px ${c})` : "none",
          opacity: d.active ? 0.95 : 0.5,
          transition: "stroke 0.4s ease, opacity 0.4s ease",
        }}
      />

      {/* Live: under-glow beam + multi-particle stream with trail */}
      {d.active && (
        <>
          <path
            d={path}
            fill="none"
            stroke={c}
            strokeWidth={6}
            opacity={0.12}
            style={{ filter: `blur(3px)` }}
          />
          <circle r="3.5" fill={c} opacity="1" style={{ filter: `drop-shadow(0 0 8px ${c})` }}>
            <animateMotion dur={duration} repeatCount="indefinite" path={path} />
          </circle>
          <circle r="1.5" fill="white" opacity="0.95">
            <animateMotion dur={duration} repeatCount="indefinite" path={path} />
          </circle>
          <circle r="2" fill={c} opacity="0.7" style={{ filter: `drop-shadow(0 0 4px ${c})` }}>
            <animateMotion dur={duration} repeatCount="indefinite" begin="-0.15s" path={path} />
          </circle>
          <circle r="1.3" fill={c} opacity="0.45">
            <animateMotion dur={duration} repeatCount="indefinite" begin="-0.3s" path={path} />
          </circle>
          <circle r="0.8" fill={c} opacity="0.25">
            <animateMotion dur={duration} repeatCount="indefinite" begin="-0.45s" path={path} />
          </circle>
        </>
      )}

      {/* HUD label tag with corner brackets */}
      {d.label && d.active && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
            }}
          >
            <div className="relative rounded border border-hud bg-black/90 px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-widest text-hud glow-text">
              <span className="absolute -left-1 -top-1 h-1.5 w-1.5 border border-hud" />
              <span className="absolute -right-1 -bottom-1 h-1.5 w-1.5 border border-hud" />
              {d.label}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
