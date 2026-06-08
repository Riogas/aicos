import type { ReactNode } from "react";

export function Card({ title, subtitle, children, accent }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  accent?: "ok" | "warn" | "err";
}) {
  const dot = accent === "ok" ? "bg-success" : accent === "warn" ? "bg-warn" : accent === "err" ? "bg-danger" : "bg-muted";
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
        <h2 className="text-sm font-semibold text-neutral-200">{title}</h2>
        {subtitle && <span className="ml-2 text-xs text-muted">{subtitle}</span>}
      </div>
      <div className="text-sm text-neutral-300">{children}</div>
    </div>
  );
}

export function Stat({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={`text-lg ${mono ? "font-mono" : ""} text-neutral-100`}>{value}</span>
    </div>
  );
}
