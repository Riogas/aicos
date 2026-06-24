"use client";

import { useState } from "react";

/**
 * Minimal token-entry page. Submits to /api/login which sets the cookie.
 */
export default function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const from = params.get("from") ?? "/flow";
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!r.ok) {
        setError("Invalid token");
        setPending(false);
        return;
      }
      window.location.href = from;
    } catch {
      setError("Network error");
      setPending(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-black">
      <form
        onSubmit={onSubmit}
        className="w-80 border border-hud-dim bg-black/85 px-5 py-6 backdrop-blur-md"
        style={{
          clipPath:
            "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))",
          boxShadow: "0 0 20px rgba(0,255,156,0.15)",
        }}
      >
        <div className="font-mono text-[10px] uppercase tracking-widest text-hud glow-text">
          ◢ AICOS LIVE TACTICAL VIEW
        </div>
        <div className="my-2 h-px bg-hud-dim" />
        <div className="font-mono text-[8.5px] uppercase tracking-widest text-hud-dim">
          Access token required
        </div>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="mt-3 w-full border border-hud-dim bg-black px-2 py-1.5 font-mono text-sm text-hud focus:border-hud focus:outline-none"
          placeholder="token"
        />
        {error && (
          <div className="mt-2 font-mono text-[8.5px] uppercase tracking-widest text-alert">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={pending || token.length === 0}
          className="mt-3 w-full border border-hud bg-hud/10 px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-hud transition hover:bg-hud/20 disabled:opacity-50"
        >
          {pending ? "Verifying…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
