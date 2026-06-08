/**
 * HTTP client del Tool Gateway al Policy Engine.
 * Si POLICY_SERVICE_URL no esta seteado, fail-open (allow).
 */

export interface PolicyDecision {
  decision: "allow" | "require_approval" | "deny";
  reason: string;
}

const TIMEOUT_MS = 2000;

export interface PolicyClient {
  evaluate(input: {
    actor: { type: "agent" | "user" | "system"; id: string; registryId?: string; companyId?: string };
    action: string;
    riskFlags?: string[];
    estimatedCostUsd?: number;
    resource?: { type: string; id?: string };
    approved?: boolean;
  }): Promise<PolicyDecision>;
  isEnabled(): boolean;
}

export function createPolicyClient(url: string | undefined): PolicyClient {
  if (!url) {
    return {
      isEnabled: () => false,
      evaluate: async () => ({ decision: "allow", reason: "policy client not configured (fail-open)" }),
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
          return { decision: "deny", reason: `policy /evaluate HTTP ${res.status}` };
        }
        return (await res.json()) as PolicyDecision;
      } catch (e) {
        // Network error on policy → safer to fail-closed (deny) for the gateway
        return { decision: "deny", reason: `policy unreachable: ${(e as Error).message}` };
      }
    },
  };
}
