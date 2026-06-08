import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import {
  Activity,
  Gauge,
  Sparkles,
  Shield,
  Terminal,
} from "lucide-react";
import { safeFetch, URLS } from "@/lib/fetcher";

export const metadata: Metadata = {
  title: "AICOS · Ops Dashboard",
  description: "AI Company OS — live ops view of routing, quota, learning, policy.",
};

const NAV = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/quota", label: "Quota", icon: Gauge },
  { href: "/learning", label: "Learning", icon: Sparkles },
  { href: "/policy", label: "Policy", icon: Shield },
  { href: "/runs", label: "Runs", icon: Terminal },
];

async function HeaderStatus() {
  const [bridge, quota] = await Promise.all([
    safeFetch<{ status?: string }>(URLS.bridgeHealth()),
    safeFetch<{ survivalActive?: boolean }>(URLS.quotaStatus()),
  ]);
  const survival = quota.ok && quota.data?.survivalActive;
  const allOk = bridge.ok && quota.ok && !survival;
  const tone = survival
    ? "border-warning/40 bg-warning-soft text-warning"
    : !bridge.ok || !quota.ok
      ? "border-danger/40 bg-danger-soft text-danger"
      : "border-success/40 bg-success-soft text-success";
  const label = survival ? "Survival" : allOk ? "Operational" : "Degraded";
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${
            survival ? "bg-warning" : allOk ? "bg-success" : "bg-danger"
          }`}
        />
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
            survival ? "bg-warning" : allOk ? "bg-success" : "bg-danger"
          }`}
        />
      </span>
      {label}
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-bg font-sans text-fg">
        {/* Top gradient glow */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[480px] bg-grid-fade" />

        <header className="sticky top-0 z-40 border-b border-border bg-bg/70 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center gap-8 px-6 py-3.5">
            <Link href="/" className="group flex items-center gap-2.5">
              <Logo />
              <span className="text-sm font-semibold tracking-tighter2 text-fg">
                AICOS
              </span>
              <span className="hidden text-xs font-medium text-subtle sm:inline">
                / ops
              </span>
            </Link>
            <nav className="flex items-center gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
                >
                  <item.icon className="h-3.5 w-3.5" strokeWidth={2} />
                  <span>{item.label}</span>
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <HeaderStatus />
              <span className="hidden font-mono text-2xs uppercase tracking-tightest text-subtle md:inline">
                v0.1
              </span>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-6 py-10">{children}</main>

        <footer className="mx-auto max-w-7xl px-6 pb-10">
          <div className="border-t border-border pt-6 text-xs text-subtle">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <span>
                bridge <code className="text-muted">:7100</code>
              </span>
              <span>
                quota <code className="text-muted">:7001</code>
              </span>
              <span>
                policy <code className="text-muted">:7002</code>
              </span>
              <span>
                learning <code className="text-muted">:7003</code>
              </span>
              <span>
                paperclip <code className="text-muted">:3100</code>
              </span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}

function Logo() {
  return (
    <div className="relative grid h-6 w-6 place-items-center overflow-hidden rounded-md bg-gradient-to-br from-accent to-violet shadow-glow">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="text-white"
      >
        <path
          d="M6 19V5h4l4 14h4M9 12h6"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
