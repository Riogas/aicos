import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "AICOS Dashboard",
  description: "AI Company OS — ops surface",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/quota", label: "Quota" },
  { href: "/learning", label: "Learning" },
  { href: "/policy", label: "Policy" },
  { href: "/runs", label: "Runs" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-neutral-100">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-4">
            <Link href="/" className="font-mono text-sm font-bold text-accent">
              AICOS
            </Link>
            <nav className="flex gap-4 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-neutral-300 transition hover:text-white"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto text-xs text-muted">
              <span className="font-mono">dashboard 0.1</span>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
