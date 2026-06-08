import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string | ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`relative overflow-hidden rounded-xl border border-border bg-surface bg-card-bevel shadow-card transition-all duration-200 hover:border-border-strong hover:shadow-card-hover ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
          <div className="flex items-baseline gap-2">
            {title && (
              <h3 className="text-sm font-semibold tracking-tight text-fg">
                {title}
              </h3>
            )}
            {subtitle && (
              <span className="font-mono text-2xs uppercase tracking-tightest text-subtle">
                {subtitle}
              </span>
            )}
          </div>
          {action && <div>{action}</div>}
        </header>
      )}
      <div className="px-5 py-4 text-sm text-muted">{children}</div>
    </section>
  );
}

export function CardEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border/60 px-4 py-6 text-center text-xs text-subtle">
      {children}
    </div>
  );
}
