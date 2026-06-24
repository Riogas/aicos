import { FlowViewer } from "./client";
import "./jarvis.css";

export const dynamic = "force-dynamic";

export default function FlowPage() {
  return (
    <div
      className="jarvis-viewport relative border-y border-hud-dim"
      style={{
        height: "calc(100vh - 110px)",
        marginTop: "-40px",
        marginBottom: "-40px",
        marginLeft: "calc(50% - 50vw)",
        marginRight: "calc(50% - 50vw)",
        width: "100vw",
      }}
    >
      <span className="jarvis-frame tl" />
      <span className="jarvis-frame tr" />
      <span className="jarvis-frame bl" />
      <span className="jarvis-frame br" />
      <div className="jarvis-ticks" />

      <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 font-mono text-[9px] uppercase tracking-[0.4em] text-hud-dim hud-flicker">
        ◄ LAT 34.9°S · LON 56.1°W · ALT 0m · AICOS-LINK ►
      </div>

      <div className="pointer-events-none absolute left-12 top-3 z-20">
        <div className="font-mono text-base font-bold uppercase tracking-widest text-hud glow-text">
          ◢ LIVE TACTICAL VIEW
        </div>
        <div className="font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
          J.A.R.V.I.S. AGENT ORCHESTRATION OVERLAY · SSE LINK · ADAPTIVE POLL
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-12 z-20 font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
        ◢ HOLD <kbd className="rounded border border-hud-dim bg-black px-1 py-0.5 text-hud">SPACE</kbd> PAN · SCROLL ZOOM · GLOW = TRAFFIC · VIOLET = LEARN→ROUTE
      </div>

      <div className="pointer-events-none absolute bottom-3 right-12 z-20 flex items-center gap-2 font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
        <span className="flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hud opacity-75" />
            <span
              className="relative inline-flex h-1.5 w-1.5 rounded-full bg-hud"
              style={{ boxShadow: "0 0 6px #00ff9c" }}
            />
          </span>
          SIGNAL · ONLINE
        </span>
        <span className="text-hud">▮▮▮▮▮▮▮▯</span>
        <span>v0.2 · BUILD 10JUN26</span>
      </div>

      <FlowViewer />
    </div>
  );
}
