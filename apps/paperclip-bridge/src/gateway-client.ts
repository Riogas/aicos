/**
 * Minimal client for aicos-tool-gateway.
 *
 * Used by the orchestrator to push synthetic audit entries when something
 * notable happens (task decomposed, subtasks created, parent reconciled).
 * Those entries surface on the dashboard's Tool Gateway node.
 *
 * Fail-open: errors never propagate — the orchestrator should keep going
 * even if the gateway is offline.
 */

export interface GatewayClient {
  isEnabled(): boolean;
  logAudit(input: {
    tool?: string;
    action: string;
    actor?: { id: string; registryId?: string };
    decision?: "allow" | "deny" | "require_approval";
    reason?: string;
    params?: Record<string, unknown>;
  }): Promise<void>;
}

const TIMEOUT_MS = 1500;

export function createGatewayClient(url: string | undefined): GatewayClient {
  if (!url) {
    return { isEnabled: () => false, logAudit: async () => {} };
  }
  const base = url.replace(/\/$/, "");
  return {
    isEnabled: () => true,
    async logAudit(input) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(`${base}/audit/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) {
          process.stderr.write(`[gateway] /audit/log ${res.status}\n`);
        }
      } catch (e) {
        // best-effort — never throw
        process.stderr.write(`[gateway] /audit/log fail: ${(e as Error).message}\n`);
      }
    },
  };
}
