import Fastify, { type FastifyInstance } from "fastify";
import type { Ruleset } from "./types.js";
import { evaluateInputSchema } from "./types.js";
import { evaluate } from "./rules.js";

export interface ServerOpts {
  port: number;
  ruleset: Ruleset;
  policyEnabled: boolean;
}

/** Ring buffer of recent /evaluate calls — drives dashboard Policy node activity. */
interface AuditEntry {
  ts: string;
  actor: { id: string; type?: string };
  action: string;
  resource?: string;
  decision: string;
  reason?: string;
}
const AUDIT_BUFFER_MAX = 100;

export async function startServer(opts: ServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  // Append-only ring buffer; oldest entries get dropped past AUDIT_BUFFER_MAX.
  const auditLog: AuditEntry[] = [];

  app.get("/health", async () => ({
    status: "ok",
    service: "aicos-policy-engine",
    policyEnabled: opts.policyEnabled,
    ruleCount: opts.ruleset.rules.length,
    auditEntries: auditLog.length,
  }));

  app.get("/rules", async () => opts.ruleset);

  // Recent audit entries — used by the dashboard to flip the Policy node from
  // idle to live when a real evaluation just happened.
  app.get("/audit/recent", async (req) => {
    const limitRaw = (req.query as { limit?: string })?.limit;
    const limit = limitRaw && /^\d+$/.test(limitRaw)
      ? Math.min(AUDIT_BUFFER_MAX, Number.parseInt(limitRaw, 10))
      : 20;
    return { items: auditLog.slice(-limit).reverse() };
  });

  app.post("/evaluate", async (req, reply) => {
    const parsed = evaluateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation", details: parsed.error.issues };
    }
    if (!opts.policyEnabled) {
      const result = {
        decision: "allow" as const,
        reason: "policy engine disabled (POLICY_ENABLED=false)",
        evaluated: parsed.data,
      };
      pushAudit(auditLog, parsed.data, result);
      return result;
    }
    const result = evaluate(parsed.data, opts.ruleset);
    pushAudit(auditLog, parsed.data, result);
    return result;
  });

  await app.listen({ host: "0.0.0.0", port: opts.port });
  return app;
}

function pushAudit(
  buffer: AuditEntry[],
  input: {
    actor?: { id?: string; type?: string };
    action?: string;
    // The schema's `resource` is a structured object — we flatten it to a
    // short string for audit display.
    resource?: { type?: string; id?: string; workspaceCwd?: string };
  },
  result: { decision: string; reason?: string },
): void {
  const resourceStr = input.resource
    ? `${input.resource.type ?? "?"}${input.resource.id ? `:${input.resource.id}` : ""}`
    : undefined;
  buffer.push({
    ts: new Date().toISOString(),
    actor: { id: input.actor?.id ?? "?", type: input.actor?.type },
    action: input.action ?? "?",
    resource: resourceStr,
    decision: result.decision,
    reason: result.reason,
  });
  while (buffer.length > AUDIT_BUFFER_MAX) buffer.shift();
}
