import type { ReactNode, ElementType } from "react";

export function MetricTile({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
  icon: Icon,
  trend,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "err" | "accent";
  icon?: ElementType;
  trend?: ReactNode;
}) {
  const toneClass =
    tone === "ok"
      ? "text-success"
      : tone === "warn"
        ? "text-warning"
        : tone === "err"
          ? "text-danger"
          : tone === "accent"
            ? "text-accent"
            : "text-fg";

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface bg-card-bevel p-5 shadow-card transition-all duration-200 hover:border-border-strong hover:shadow-card-hover">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-tightest text-subtle">
          {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={2} />}
          {label}
        </div>
        {trend}
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <div
          className={`font-mono text-3xl font-semibold tabular tracking-tightest ${toneClass}`}
        >
          {value}
        </div>
        {unit && (
          <div className="font-mono text-xs uppercase tracking-tightest text-subtle">
            {unit}
          </div>
        )}
      </div>
      {hint && <div className="mt-1 text-xs text-subtle">{hint}</div>}
    </div>
  );
}
