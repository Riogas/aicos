/**
 * HTTP client minimo al @aicos/quota-manager (R3).
 *
 * Opt-in via env QUOTA_SERVICE_URL. Si no esta seteada, todos los metodos
 * devuelven null (no-op) y el caller debe usar el preferredModel como antes.
 *
 * Tolerante a fallos: si el servicio esta caido / 5xx, loggea warning y
 * devuelve null. NUNCA tira excepciones que rompan el run del agente.
 */

import type { Candidate } from "./provider-map.js";

export interface SelectResult {
  chosen: Candidate;
  reason: "preferred" | "fallback" | "survival" | "first-when-disabled";
  survivalActive: boolean;
  skipped: Array<{ candidate: Candidate; reason: string }>;
}

export interface UsageInput {
  provider: string;
  cli?: string;
  costUsd: number;
  requests?: number;
  tokens?: { input?: number; output?: number; cached?: number };
  model?: string;
  agentRegistryId?: string;
  ticketId?: string;
}

export interface QuotaClient {
  selectModel(input: {
    role?: string;
    task?: "trivial" | "bug-fix" | "small-feature" | "critical" | "large-context";
    candidates: Candidate[];
  }): Promise<SelectResult | null>;
  recordUsage(input: UsageInput): Promise<boolean>;
  isEnabled(): boolean;
}

const TIMEOUT_MS = 3000;

export function createQuotaClient(url: string | undefined): QuotaClient {
  if (!url) {
    return {
      selectModel: async () => null,
      recordUsage: async () => false,
      isEnabled: () => false,
    };
  }
  const base = url.replace(/\/$/, "");
  return {
    isEnabled: () => true,
    async selectModel(input) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(`${base}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (res.status === 503) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          process.stderr.write(
            `[quota] /select 503: ${body.error ?? "no-candidate-available"}\n`,
          );
          return null;
        }
        if (!res.ok) {
          process.stderr.write(`[quota] /select ${res.status}\n`);
          return null;
        }
        return (await res.json()) as SelectResult;
      } catch (e) {
        process.stderr.write(`[quota] /select fail: ${(e as Error).message}\n`);
        return null;
      }
    },
    async recordUsage(input) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(`${base}/usage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) {
          process.stderr.write(`[quota] /usage ${res.status}\n`);
          return false;
        }
        return true;
      } catch (e) {
        process.stderr.write(`[quota] /usage fail: ${(e as Error).message}\n`);
        return false;
      }
    },
  };
}
