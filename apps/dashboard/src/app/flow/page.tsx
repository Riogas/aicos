import { FlowViewer } from "./client";

export const dynamic = "force-dynamic";

export default function FlowPage() {
  return (
    <div className="space-y-4 animate-fade-in">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tightest text-fg">Live Flow</h1>
          <p className="mt-1 text-sm text-muted">
            Real-time view of agent orchestration. Nodes pulse when active, edges animate when data flows. Auto-refresh every 2 seconds.
          </p>
        </div>
      </header>

      <div className="relative h-[820px] overflow-hidden rounded-xl border border-border bg-surface bg-card-bevel shadow-card">
        <FlowViewer />
      </div>

      <p className="text-xs text-subtle">
        Tip: hold <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-2xs">space</kbd> to pan,
        scroll to zoom. Dotted edges = idle path, glowing edges = live traffic.
      </p>
    </div>
  );
}
