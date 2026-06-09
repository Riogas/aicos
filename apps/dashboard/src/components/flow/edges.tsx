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
    idle: "rgba(255,255,255,0.12)",
    live: "rgba(59,130,246,0.9)",
    warn: "rgba(245,158,11,0.85)",
    err: "rgba(239,68,68,0.85)",
    accent: "rgba(168,85,247,0.85)",
  };
  const c = colorMap[d.tone ?? (d.active ? "live" : "idle")];

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: c,
          strokeWidth: d.active ? 1.8 : 1,
          filter: d.active ? `drop-shadow(0 0 6px ${c})` : "none",
          opacity: d.active ? 1 : 0.5,
          transition: "all 0.4s ease",
        }}
      />
      {d.active && (
        <>
          <circle r="4" fill={c}>
            <animateMotion
              dur={d.tone === "accent" ? "2.4s" : "1.6s"}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
          <circle r="2" fill="white" opacity="0.95">
            <animateMotion
              dur={d.tone === "accent" ? "2.4s" : "1.6s"}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
        </>
      )}
      {d.label && d.active && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
            }}
            className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-tightest text-fg"
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
