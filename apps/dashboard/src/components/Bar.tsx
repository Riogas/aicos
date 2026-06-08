export function Bar({
  percent,
  size = "md",
}: {
  percent: number;
  size?: "sm" | "md";
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const fill =
    clamped >= 90
      ? "bg-danger"
      : clamped >= 70
        ? "bg-warning"
        : clamped >= 30
          ? "bg-accent"
          : "bg-success";
  const h = size === "sm" ? "h-1" : "h-1.5";
  return (
    <div className={`relative w-full overflow-hidden rounded-full bg-surface-3 ${h}`}>
      <div
        className={`h-full rounded-full ${fill} transition-all duration-500`}
        style={{ width: `${clamped}%` }}
      />
      {/* Subtle inner highlight */}
      <div
        className="pointer-events-none absolute inset-0 rounded-full opacity-30"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, transparent 50%)",
        }}
      />
    </div>
  );
}

export function Ring({
  percent,
  label,
  sublabel,
  size = 96,
}: {
  percent: number;
  label?: string;
  sublabel?: string;
  size?: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const stroke =
    clamped >= 90
      ? "stroke-danger"
      : clamped >= 70
        ? "stroke-warning"
        : "stroke-accent";

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth="4"
          className="stroke-surface-3"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={`${stroke} transition-all duration-700`}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        {label && (
          <div className="font-mono text-base font-semibold tabular text-fg">
            {label}
          </div>
        )}
        {sublabel && (
          <div className="font-mono text-2xs uppercase tracking-tightest text-subtle">
            {sublabel}
          </div>
        )}
      </div>
    </div>
  );
}
