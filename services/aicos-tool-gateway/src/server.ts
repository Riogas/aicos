import Fastify, { type FastifyInstance } from "fastify";
import type Redis from "ioredis";
import type { PolicyClient } from "./policy-client.js";
import { RedisAudit, type AuditEntry } from "./audit.js";
import {
  browserSchema,
  createGithubIssue,
  dockerSchema,
  githubIssueSchema,
  runBrowserFetch,
  runDockerCmd,
  runShellCmd,
  shellSchema,
} from "./tools.js";

export interface ServerOpts {
  port: number;
  redis: Redis;
  policyClient: PolicyClient;
  gatewayEnabled: boolean;
}

export async function startServer(opts: ServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const audit = new RedisAudit(opts.redis);

  app.get("/health", async () => ({
    status: "ok",
    service: "aicos-tool-gateway",
    gatewayEnabled: opts.gatewayEnabled,
    policy: opts.policyClient.isEnabled() ? "configured" : "missing",
  }));

  app.get("/audit/recent", async () => ({ items: await audit.recent(50) }));

  // POST /audit/log — generic audit-record endpoint. Used by the bridge's
  // orchestrator to log synthetic actions (e.g. "decomposed task into 4
  // subtasks") so the dashboard's Tool Gateway node lights up on real
  // orchestration activity, not just direct tool calls.
  app.post("/audit/log", async (req, reply) => {
    const body = req.body as
      | {
          tool?: string;
          action?: string;
          actor?: { id?: string; registryId?: string };
          decision?: string;
          reason?: string;
          params?: Record<string, unknown>;
        }
      | undefined;
    if (!body?.action) {
      reply.code(400);
      return { error: "missing action" };
    }
    await audit.record({
      ts: new Date().toISOString(),
      tool: body.tool ?? "synthetic",
      action: body.action,
      actor: { id: body.actor?.id ?? "?", registryId: body.actor?.registryId },
      decision: (body.decision ?? "allow") as AuditEntry["decision"],
      reason: body.reason,
      params: body.params,
    });
    return { ok: true };
  });

  // Generic policy + audit wrapper for tool actions
  async function runTool<I>(
    tool: string,
    action: string,
    actor: AuditEntry["actor"],
    input: I,
    riskFlags: string[],
    estimatedCostUsd: number | undefined,
    exec: () => Promise<{ ok: boolean; status?: number }>,
  ) {
    const ts = new Date().toISOString();
    const startedAt = Date.now();
    if (opts.gatewayEnabled) {
      const policy = await opts.policyClient.evaluate({
        actor: { type: "agent", id: actor.id, registryId: actor.registryId },
        action,
        riskFlags,
        estimatedCostUsd,
        // Policy resource enum doesn't include github/docker — wrap as tool-call.
        resource: { type: "tool-call", id: tool },
      });
      if (policy.decision !== "allow") {
        const entry: AuditEntry = {
          ts,
          tool,
          action,
          actor,
          decision: policy.decision,
          reason: policy.reason,
          params: input as Record<string, unknown>,
        };
        await audit.record(entry);
        return {
          ok: false,
          decision: policy.decision,
          reason: policy.reason,
        };
      }
    }
    const result = await exec();
    const durationMs = Date.now() - startedAt;
    await audit.record({
      ts,
      tool,
      action,
      actor,
      decision: "allow",
      params: input as Record<string, unknown>,
      result: { ok: result.ok, status: result.status, durationMs },
    });
    return { ok: result.ok, decision: "allow", result };
  }

  // ── GitHub ────────────────────────────────────────────────────────────────
  app.post("/github/issue", async (req, reply) => {
    const r = githubIssueSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    return runTool(
      "github",
      "github:create_issue",
      { id: r.data.actor.id, registryId: r.data.actor.registryId },
      r.data,
      r.data.dryRun ? [] : ["external-api"],
      undefined,
      () => createGithubIssue(r.data),
    );
  });

  // ── Docker ────────────────────────────────────────────────────────────────
  app.post("/docker", async (req, reply) => {
    const r = dockerSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    return runTool(
      "docker",
      `docker:${r.data.cmd}`,
      { id: r.data.actor.id, registryId: r.data.actor.registryId },
      r.data,
      [],
      undefined,
      () => runDockerCmd(r.data) as Promise<{ ok: boolean }>,
    );
  });

  // ── Browser / web fetch ────────────────────────────────────────────────────
  app.post("/browser/fetch", async (req, reply) => {
    const r = browserSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    return runTool(
      "browser",
      "browser:fetch",
      { id: r.data.actor.id, registryId: r.data.actor.registryId },
      r.data,
      ["external-api"],
      undefined,
      () => runBrowserFetch(r.data),
    );
  });

  // ── Shell (very restricted read-only) ──────────────────────────────────────
  app.post("/shell", async (req, reply) => {
    const r = shellSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    return runTool(
      "shell",
      "shell:run",
      { id: r.data.actor.id, registryId: r.data.actor.registryId },
      r.data,
      [],
      undefined,
      () => runShellCmd(r.data) as Promise<{ ok: boolean }>,
    );
  });

  await app.listen({ host: "0.0.0.0", port: opts.port });
  return app;
}
