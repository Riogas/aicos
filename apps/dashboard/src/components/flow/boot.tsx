"use client";

import { useEffect, useState } from "react";

/**
 * JARVIS boot sequence — plays once per browser session (sessionStorage),
 * skippable with click / any key. Pure theatre, ~2.6s.
 */
const BOOT_LINES = [
  "MATRIX KERNEL v0.2 — INITIALIZING",
  "▸ LINK BRIDGE:7100 ............ OK",
  "▸ LINK PAPERCLIP:3100 ......... OK",
  "▸ QUOTA MANAGER ............... ARMED",
  "▸ POLICY ENGINE ............... 5 RULES LOADED",
  "▸ LEARNING CORE ............... SMART-ROUTING ON",
  "▸ AGENT ROSTER ................ 26 UNITS STANDBY",
  "▸ TELEMETRY STREAM ............ SSE LOCKED",
  "ALL SYSTEMS NOMINAL — WELCOME BACK, OPERATOR",
];

const LINE_DELAY_MS = 210;
const EXIT_AFTER_MS = BOOT_LINES.length * LINE_DELAY_MS + 650;

export function BootSequence() {
  const [phase, setPhase] = useState<"hidden" | "playing" | "exiting">("hidden");
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("aicos-booted")) return;
    setPhase("playing");

    const lineTimers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i <= BOOT_LINES.length; i++) {
      lineTimers.push(setTimeout(() => setVisibleLines(i), i * LINE_DELAY_MS));
    }
    const exitTimer = setTimeout(() => finish(), EXIT_AFTER_MS);

    const finish = () => {
      sessionStorage.setItem("aicos-booted", "1");
      setPhase("exiting");
      setTimeout(() => setPhase("hidden"), 750);
    };
    const skip = () => finish();
    window.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);

    return () => {
      lineTimers.forEach(clearTimeout);
      clearTimeout(exitTimer);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
  }, []);

  if (phase === "hidden") return null;

  const done = visibleLines >= BOOT_LINES.length;

  return (
    <div className={`boot-overlay ${phase === "exiting" ? "exiting" : ""}`}>
      {phase === "exiting" && <span className="boot-iris" />}
      <div className="w-[420px] max-w-[88vw]">
        <div className="mb-3 flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.45em] text-hud glow-text">
            ◢ A.I.C.O.S
          </span>
          <span className="h-px flex-1 bg-hud-dim" />
          <span className="font-mono text-[8px] uppercase tracking-widest text-hud-dim">
            SECURE BOOT
          </span>
        </div>
        <div className="min-h-[190px] border border-hud-dim bg-black/60 px-4 py-3">
          {BOOT_LINES.slice(0, visibleLines).map((l, i) => (
            <div
              key={i}
              className={`boot-line font-mono text-[10.5px] uppercase tracking-wider ${
                i === BOOT_LINES.length - 1 ? "mt-1.5 text-hud glow-text" : "text-hud-dim"
              }`}
            >
              {l}
            </div>
          ))}
          {!done && <span className="boot-cursor font-mono text-[10.5px]" />}
        </div>
        <div className="mt-2 h-0.5 w-full overflow-hidden bg-hud-soft">
          <div
            className="h-full bg-hud"
            style={{
              width: `${(visibleLines / BOOT_LINES.length) * 100}%`,
              boxShadow: "0 0 8px rgba(0,255,156,0.9)",
              transition: "width 0.2s linear",
            }}
          />
        </div>
        <div className="mt-1.5 text-center font-mono text-[8px] uppercase tracking-[0.3em] text-hud-dim">
          CLICK TO SKIP
        </div>
      </div>
    </div>
  );
}
