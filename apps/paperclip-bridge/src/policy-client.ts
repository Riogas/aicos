/**
 * Minimal HTTP client for aicos-policy-engine /evaluate.
 *
 * Fail-open: any network error / 5xx / timeout returns { decision: "allow",
 * reason: "policy-engine-unavailable" } so the bridge never gets stuck because
 * a side service is down. Real "deny" decisions require an actual policy hit.
 */

export type Decision = "allow" | "require_approval" | "deny";

export interface PolicyDecision {
  decision: Decision;
  reason?: string;
  matchedRule?: string;
}

export interface EvaluateRequest {
  actor: {
    type: "agent" | "user" | "system";
    id: string;
    registryId?: string;
    department?: string;
    companyId?: string;
  };
  action: string;
  resource?: {
    type: "ticket" | "workspace" | "deploy" | "model-run" | "tool-call";
    id?: string;
    workspaceCwd?: string;
    projectId?: string;
    ticketIdentifier?: string;
  };
  bucket?: "trivial" | "bug-fix" | "small-feature" | "large-feature" | "critical-feature";
  riskFlags?: string[];
  estimatedCostUsd?: number;
}

export interface PolicyClient {
  evaluate(input: EvaluateRequest): Promise<PolicyDecision>;
  isEnabled(): boolean;
}

const TIMEOUT_MS = 1500;

export function createPolicyClient(url: string | undefined): PolicyClient {
  if (!url) {
    return {
      isEnabled: () => false,
      evaluate: async () => ({ decision: "allow", reason: "policy-disabled" }),
    };
  }
  const base = url.replace(/\/$/, "");
  return {
    isEnabled: () => true,
    async evaluate(input) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(`${base}/evaluate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) {
          process.stderr.write(`[policy] /evaluate ${res.status} — falling open\n`);
          return { decision: "allow", reason: `policy-${res.status}` };
        }
        return (await res.json()) as PolicyDecision;
      } catch (e) {
        process.stderr.write(`[policy] /evaluate fail: ${(e as Error).message} — falling open\n`);
        return { decision: "allow", reason: "policy-error" };
      }
    },
  };
}
