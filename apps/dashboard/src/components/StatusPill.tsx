import type { ReactNode } from "react";

export type Tone = "ok" | "warn" | "err" | "accent" | "violet" | "neutral";

const TONE_CLASSES: Record<Tone, string> = {
  ok: "border-success/30 bg-success-soft text-success",
  warn: "border-warning/30 bg-warning-soft text-warning",
  err: "border-danger/30 bg-danger-soft text-danger",
  accent: "border-accent/30 bg-accent-soft text-accent",
  violet: "border-violet/30 bg-violet-soft text-violet",
  neutral: "border-border-strong bg-surface-2 text-muted",
};

const DOT_CLASSES: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  err: "bg-danger",
  accent: "bg-accent",
  violet: "bg-violet",
  neutral: "bg-muted",
};

export function StatusPill({
  tone = "neutral",
  pulse = false,
  children,
}: {
  tone?: Tone;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${DOT_CLASSES[tone]}`}
          />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} />
      </span>
      {children}
    </span>
  );
}

export function Badge({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-tightest ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
