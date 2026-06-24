import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Pure dark Vercel/Linear style — 3 tonal layers
        bg: "#000000",
        surface: "#0a0a0a",
        "surface-2": "#111111",
        "surface-3": "#1a1a1a",

        // Subtle borders — white at low opacity
        border: "rgba(255,255,255,0.08)",
        "border-strong": "rgba(255,255,255,0.14)",

        // Text hierarchy
        fg: "#fafafa",
        muted: "#a1a1aa",       // zinc-400
        subtle: "#71717a",      // zinc-500
        ghost: "#52525b",       // zinc-600

        // Single brand accent + semantic tokens
        accent: "#00e676",      // blue-500
        "accent-soft": "rgba(0,230,118,0.12)",
        "accent-ring": "rgba(0,230,118,0.30)",

        success: "#22c55e",     // green-500
        "success-soft": "rgba(34,197,94,0.12)",
        warning: "#f59e0b",     // amber-500
        "warning-soft": "rgba(245,158,11,0.12)",
        danger: "#ef4444",      // red-500
        "danger-soft": "rgba(239,68,68,0.12)",
        violet: "#a855f7",
        "violet-soft": "rgba(168,85,247,0.12)",
        // ─── Iron Man / JARVIS palette ───
        hud: "#00ff9c",
        "hud-dim": "rgba(0,255,156,0.35)",
        "hud-soft": "rgba(0,255,156,0.10)",
        "hud-glow": "rgba(0,255,156,0.55)",
        "hud-ring": "rgba(0,255,156,0.25)",
        gold: "#fbbf24",
        "gold-dim": "rgba(251,191,36,0.5)",
        "gold-soft": "rgba(251,191,36,0.10)",
        alert: "#ff3b30",
        "alert-glow": "rgba(255,59,48,0.5)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        "2xs": ["10px", { lineHeight: "12px", letterSpacing: "0.04em" }],
      },
      letterSpacing: {
        tightest: "-0.04em",
        tighter2: "-0.025em",
      },
      boxShadow: {
        // soft inner top highlight + outer drop — gives layered "raised card" feel
        card: "inset 0 1px 0 0 rgba(255,255,255,0.04), 0 1px 2px 0 rgba(0,0,0,0.4)",
        "card-hover": "inset 0 1px 0 0 rgba(255,255,255,0.06), 0 4px 12px -2px rgba(0,0,0,0.5)",
        glow: "0 0 0 1px rgba(0,230,118,0.25), 0 4px 24px -4px rgba(0,230,118,0.18)",
      },
      backgroundImage: {
        "grid-fade":
          "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(0,230,118,0.12), transparent 60%)",
        "card-bevel":
          "linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 100%)",
      },
      animation: {
        pulse: "pulse 2s ease-in-out infinite",
        "fade-in": "fadeIn 0.3s ease-out",
        shimmer: "shimmer 2s linear infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
