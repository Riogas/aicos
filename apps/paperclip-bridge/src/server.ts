import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import Redis from "ioredis";
import { PaperclipClient } from "./paperclip-client.js";
import { executeRun } from "./run.js";
import {
  loadRegistry,
  resolvePersonaByPaperclipId,
  resolveWorkspaceByProjectId,
} from "./registry.js";
import type { ProjectWorkspace } from "./registry.js";
import { createQuotaClient } from "./quota-client.js";
import { createLearningClient } from "./learning-client.js";
import { createPolicyClient } from "./policy-client.js";
import { runStandup, lastStandup } from "./standup.js";
import {
  storeMemory,
  retrieveFromScope,
  retrieveAllScopes,
  type MemoryScope,
} from "./memory.js";
import { ingestDocument, listDocuments, deleteDocument } from "./knowledge.js";
import {
  recordRunOutcome,
  loadRetryConfig,
  saveRetryConfig,
  retryState,
  clearRetry,
  type Disposition,
} from "./retry-manager.js";
import { agingScan, loadAgingConfig, saveAgingConfig } from "./aging.js";
import { loadTestGateConfig, saveTestGateConfig } from "./test-gate.js";
import { fireN8n } from "./n8n.js";
import { orchestrate, type OrchestrateInput } from "./orchestrator.js";
import { startSubtaskPromoter } from "./subtask-promoter.js";
import { InFlightTracker, type TrackerEvent, type RunStage } from "./in-flight-tracker.js";
import { createRunQueue, type RunJobInput } from "./run-queue.js";
import { resolvePersonaByRegistryId } from "./registry.js";
import { attachMetrics } from "./metrics.js";

const RunRequestSchema = z.object({
  issueId: z.string().optional(),
  ticketId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

type RunRequestBody = z.infer<typeof RunRequestSchema>;

export interface ServerOptions {
  port: number;
  paperclipApiUrl?: string;
  paperclipApiKey?: string;
  quotaServiceUrl?: string;
  learningServiceUrl?: string;
  policyServiceUrl?: string;
  /**
   * Company id used by the subtask promoter loop and the /orchestrate endpoint.
   * Defaults to env AICOS_COMPANY_ID; if neither is set, /orchestrate is disabled
   * and the promoter does not start.
   */
  companyId?: string;
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.BRIDGE_LOG_LEVEL ?? "info",
    },
  });

  const registryStats = loadRegistry();
  app.log.info(
    {
      ...registryStats,
    },
    "registry loaded",
  );

  const paperclipReady =
    Boolean(opts.paperclipApiUrl) && Boolean(opts.paperclipApiKey);

  const quotaClient = createQuotaClient(opts.quotaServiceUrl);
  const learningClient = createLearningClient(opts.learningServiceUrl);
  const policyClient = createPolicyClient(opts.policyServiceUrl);

  // ─── In-flight run tracking (for live dashboard heartbeat) ───────────────
  // Stage-aware tracker shared between the HTTP /run path (in-process emit) and
  // the process-adapter path (POST /stage from inside the Paperclip container).
  // Emits SSE events on every transition.
  //
  // When REDIS_URL is set the tracker persists state to Redis so an active
  // run survives a bridge restart (and any reconnecting SSE clients see it).
  const redisUrl = process.env.REDIS_URL;
  const trackerRedis = redisUrl ? new Redis(redisUrl, { lazyConnect: true }) : undefined;
  if (trackerRedis) {
    try {
      await trackerRedis.connect();
      app.log.info("[tracker] connected to Redis for persistence");
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, "[tracker] Redis connect failed — falling back to in-memory");
    }
  }
  const tracker = new InFlightTracker({ redis: trackerRedis });

  // ─── Prometheus instrumentation ──────────────────────────────────────────
  attachMetrics(app, tracker);

  // ─── Queue for /run jobs ─────────────────────────────────────────────────
  // Uses Redis when available so a bridge restart doesn't drop in-flight jobs.
  // Falls back to inline setImmediate when REDIS_URL is not configured.
  const runQueue = createRunQueue(trackerRedis, async (job: RunJobInput) => {
    const persona = job.personaRegistryId
      ? resolvePersonaByRegistryId(job.personaRegistryId)
      : undefined;
    const workspace = job.workspaceProjectId
      ? resolveWorkspaceByProjectId(job.workspaceProjectId)
      : null;
    const client =
      paperclipReady && job.paperclipIssueId
        ? new PaperclipClient(
            { apiUrl: opts.paperclipApiUrl!, apiKey: opts.paperclipApiKey! },
            job.runId,
          )
        : undefined;
    try {
      const result = await executeRun({
        prompt: job.prompt,
        model: job.model,
        provider: job.provider,
        persona: persona ?? undefined,
        workspace,
        ticketIdentifier: job.ticketIdentifier,
        paperclip:
          client && job.paperclipIssueId
            ? { client, issueId: job.paperclipIssueId }
            : undefined,
        quotaClient,
        learningClient,
        policyClient,
        tracker,
        runId: job.runId,
        approved: job.approved,
        onOutput: (chunk) => tracker.appendOutput(job.runId, chunk),
      });
      // Motor de reintentos (#7): registra el desenlace del ticket.
      if (job.paperclipIssueId) {
        void recordRunOutcome(job.paperclipIssueId, job.ticketIdentifier, result.disposition).catch((e) =>
          process.stderr.write(`[retry] recordRunOutcome warn: ${(e as Error).message}\n`),
        );
      }
    } finally {
      tracker.setStage(job.runId, "done");
    }
  });
  app.log.info(
    { persisted: runQueue.isPersisted() },
    runQueue.isPersisted() ? "run queue Redis-backed" : "run queue inline (no Redis)",
  );
  app.addHook("onClose", async () => {
    await runQueue.close();
  });
  app.log.info(
    {
      quotaEnabled: quotaClient.isEnabled(),
      quotaUrl: opts.quotaServiceUrl ?? null,
      learningEnabled: learningClient.isEnabled(),
      learningUrl: opts.learningServiceUrl ?? null,
    },
    "client init",
  );

  app.get("/health", async () => ({
    status: "ok",
    service: "aicos-bridge",
    version: "0.3.0",
    paperclip: paperclipReady ? "configured" : "missing",
    quota: quotaClient.isEnabled() ? "configured" : "missing",
    learning: learningClient.isEnabled() ? "configured" : "missing",
    hermes: "spawned-on-demand",
    registry: {
      loaded: registryStats.registryLoaded && registryStats.keysLoaded,
      resolvableAgents: registryStats.resolvable,
    },
  }));

  app.get("/in-flight", async () => {
    const items = tracker.list();
    return { count: items.length, items };
  });

  // ─── SSE stream of tracker events ────────────────────────────────────────
  // Connect via EventSource("/events"). Each event is a JSON line with
  // type ∈ {start, stage, update, end} plus the full run state. The dashboard
  // uses this to glow worker boxes per stage in real time without polling.
  app.get("/events", async (req, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    reply.raw.write(": connected\n\n");
    // Replay current state so a fresh client sees what's already running.
    for (const run of tracker.list()) {
      reply.raw.write(
        `event: snapshot\ndata: ${JSON.stringify({ run })}\n\n`,
      );
    }
    const onEvent = (evt: TrackerEvent) => {
      try {
        reply.raw.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      } catch (e) {
        // Connection probably closed
        cleanup();
      }
    };
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, 15_000);
    const cleanup = () => {
      tracker.off("event", onEvent);
      clearInterval(heartbeat);
    };
    tracker.on("event", onEvent);
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });

  // POST /stage — reports from the process-mode subprocess that runs inside the
  // Paperclip container. Body: { runId, stage, persona?, personaName?,
  // ticketIdentifier?, cli?, model? }. The first call starts the run; later
  // calls only update the stage + any new fields.
  const StageEventSchema = z.object({
    runId: z.string().min(1),
    stage: z.enum([
      "dispatched",
      "memory-retrieve",
      "quota-select",
      "cli-running",
      "posting-result",
      "done",
    ]),
    persona: z.string().optional(),
    personaName: z.string().optional(),
    ticketIdentifier: z.string().optional(),
    cli: z.string().optional(),
    model: z.string().optional(),
  });
  app.post("/stage", async (req, reply) => {
    const parsed = StageEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const { runId, stage, ...rest } = parsed.data;
    const existing = tracker.get(runId);
    if (!existing) {
      tracker.start({ runId, ...rest });
    }
    tracker.setStage(runId, stage as RunStage, rest);
    return { ok: true, stage, runId };
  });

  // POST /output — live agent output chunks from the process-mode subprocess
  // (or the in-process /run path). Feeds the dashboard's AGENT UPLINK panel via
  // the same SSE /events stream (event type "output").
  const OutputEventSchema = z.object({
    runId: z.string().min(1),
    kind: z.enum(["text", "tool", "thinking"]),
    text: z.string(),
    persona: z.string().optional(),
    personaName: z.string().optional(),
    ticketIdentifier: z.string().optional(),
  });
  app.post("/output", async (req, reply) => {
    const parsed = OutputEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.flatten() });
    }
    const { runId, kind, text, ...meta } = parsed.data;
    tracker.appendOutput(runId, { kind, text }, meta);
    return { ok: true };
  });

  app.post("/admin/reload-registry", async () => {
    const s = loadRegistry();
    app.log.info(s, "registry reloaded");
    return { ok: true, ...s };
  });

  // Read-only registry dump used by the dashboard to translate
  // Paperclip's assigneeAgentId (UUID) into our human-friendly registryId
  // (e.g. "it-architect") and to glow the right worker boxes.
  app.get("/admin/registry", async () => {
    const { listRegistryAgents } = await import("./registry.js");
    return {
      agents: listRegistryAgents().map((a) => ({
        id: a.id,
        name: a.name,
        department: a.department,
        paperclipAgentId: a.paperclipAgentId,
        preferredModel: a.preferredModel,
        fallbackChain: a.fallbackChain ?? [],
      })),
    };
  });

  // ─── Orchestrator endpoint ───────────────────────────────────────────────
  // POST /orchestrate { taskDescription, projectId, parentIssueId? }
  // Returns { decomposition, createdIssues, warnings } and creates the subtask
  // tree in Paperclip (root subs in 'todo', dependent subs in 'backlog' to be
  // promoted by the loop below as their blockers complete).
  const companyId = opts.companyId ?? process.env.AICOS_COMPANY_ID;
  const orchestrateAvailable = paperclipReady && Boolean(companyId);

  const OrchestrateRequestSchema = z.object({
    taskDescription: z.string().min(1),
    projectId: z.string().min(1),
    parentIssueId: z.string().optional(),
    defaultRole: z.string().optional(),
    triggeredBy: z.enum(["telegram", "paperclip", "manual"]).optional(),
    parentTitle: z.string().optional(),
    parentAssigneeAgentId: z.string().optional(),
  });

  // ─── Cancel endpoint ─────────────────────────────────────────────────────
  // DELETE /run/:runId — mark a tracker run as done, post a cancellation
  // comment to its ticket, and PATCH the ticket to status='cancelled'. The
  // actual subprocess (when in process-mode) keeps running until it
  // notices the ticket status — there's no cross-process kill signal — but
  // its work won't land anywhere useful because the ticket is already
  // closed. For HTTP-mode runs there's nothing to kill either; the
  // setImmediate continues but its final updateStatus will lose to ours.
  app.delete<{ Params: { runId: string }; Querystring: { reason?: string } }>(
    "/run/:runId",
    async (req, reply) => {
      const runId = req.params.runId;
      const reason = (req.query.reason ?? "cancelled by user").slice(0, 200);
      const run = tracker.get(runId);
      tracker.setStage(runId, "done");

      // Try to look up the ticket and close it.
      let issueId: string | null = null;
      if (run?.ticketIdentifier && paperclipReady && companyId) {
        try {
          const r = await fetch(
            `${opts.paperclipApiUrl!}/api/companies/${companyId}/issues?identifier=${encodeURIComponent(run.ticketIdentifier)}`,
            { headers: { Authorization: `Bearer ${opts.paperclipApiKey!}` } },
          );
          if (r.ok) {
            const data = (await r.json()) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
            const items = Array.isArray(data) ? data : data.items ?? [];
            if (items[0]) issueId = items[0].id;
          }
        } catch {
          // best-effort
        }
      }
      if (issueId && paperclipReady) {
        const client = new PaperclipClient({
          apiUrl: opts.paperclipApiUrl!,
          apiKey: opts.paperclipApiKey!,
        });
        try {
          await client.postComment(issueId, `**🛑 Cancelled:** ${reason}`);
        } catch {
          // best-effort
        }
        try {
          // Paperclip has no 'cancelled' transition for some statuses; fall back to blocked.
          await fetch(`${opts.paperclipApiUrl!}/api/issues/${issueId}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${opts.paperclipApiKey!}`,
            },
            body: JSON.stringify({ status: "cancelled" }),
          });
        } catch {
          // best-effort
        }
      }
      return reply.code(200).send({
        ok: true,
        runId,
        issueId,
        reason,
        knownRun: Boolean(run),
      });
    },
  );

  // ─── Approve endpoint ────────────────────────────────────────────────────
  // POST /approve { issueId | runId, approverNote? }
  // Re-launches a previously held run with approved=true so the policy gate
  // is skipped. Looks up the persona from the issue's assignee, re-fetches
  // prompt context from the ticket title+description, and pushes through.
  const ApproveSchema = z
    .object({
      issueId: z.string().optional(),
      runId: z.string().optional(),
      approverNote: z.string().optional(),
    })
    .refine((v) => v.issueId || v.runId, { message: "either issueId or runId required" });

  app.post("/approve", async (req, reply) => {
    const parsed = ApproveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.flatten() });
    }
    if (!paperclipReady) {
      return reply.code(503).send({ error: "paperclip not configured" });
    }
    // We need an issueId to know which ticket to relaunch. If only runId
    // was provided, look it up from the tracker.
    let issueId = parsed.data.issueId;
    if (!issueId && parsed.data.runId) {
      const run = tracker.get(parsed.data.runId);
      if (run?.ticketIdentifier) {
        // Tracker only knows the identifier (RIO-X), not the UUID. Resolve via
        // Paperclip's issues list filtered by identifier (cheap because we
        // already restrict by company).
        try {
          const r = await fetch(
            `${opts.paperclipApiUrl!}/api/companies/${companyId}/issues?identifier=${encodeURIComponent(run.ticketIdentifier)}`,
            { headers: { Authorization: `Bearer ${opts.paperclipApiKey!}` } },
          );
          if (r.ok) {
            const data = (await r.json()) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
            const items = Array.isArray(data) ? data : data.items ?? [];
            if (items[0]) issueId = items[0].id;
          }
        } catch {
          // fall through
        }
      }
    }
    if (!issueId) {
      return reply.code(404).send({ error: "issue not found for that runId — pass issueId directly" });
    }

    const client = new PaperclipClient({
      apiUrl: opts.paperclipApiUrl!,
      apiKey: opts.paperclipApiKey!,
    });

    // Fetch the issue + figure out persona from assignee.
    let issue;
    try {
      issue = await client.getIssue(issueId);
    } catch (e) {
      return reply.code(404).send({ error: "getIssue failed", details: (e as Error).message });
    }
    const assigneeAgentId = (issue as { assigneeAgentId?: string }).assigneeAgentId;
    if (!assigneeAgentId) {
      return reply.code(400).send({ error: "issue has no assigneeAgentId — cannot resolve persona" });
    }
    const { resolvePersonaByPaperclipId, resolveWorkspaceByProjectId } = await import("./registry.js");
    const persona = resolvePersonaByPaperclipId(assigneeAgentId);
    if (!persona) {
      return reply.code(404).send({ error: `no persona for assigneeAgentId=${assigneeAgentId}` });
    }
    const projectId = (issue as { projectId?: string }).projectId;
    const workspace = projectId ? resolveWorkspaceByProjectId(projectId) : null;
    const ticketIdentifier = (issue as { identifier?: string }).identifier;
    const title = (issue as { title?: string }).title ?? "";
    const description = (issue as { description?: string }).description ?? "";
    const prompt = `${title}\n\n${description}`.trim();

    // Post the approver note to the ticket if provided.
    if (parsed.data.approverNote) {
      try {
        await client.postComment(
          issueId,
          `**✅ Approved:** ${parsed.data.approverNote}`,
        );
      } catch {
        // best-effort
      }
    }

    // Unblock the ticket if it was sitting at "blocked" with our awaiting-approval marker.
    try {
      await client.updateStatus(issueId, "in_progress");
    } catch (e) {
      process.stderr.write(`[approve] updateStatus warn: ${(e as Error).message}\n`);
    }

    // Spawn the run with approved=true.
    const flightKey = parsed.data.runId || `approved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tracker.start({
      runId: flightKey,
      persona: persona.registryId,
      personaName: persona.agentName,
      cli: persona.preferredModel?.cli,
      model: persona.preferredModel?.model,
      ticketIdentifier,
    });
    await runQueue.enqueue({
      prompt,
      personaRegistryId: persona.registryId,
      workspaceProjectId: workspace?.projectName,
      ticketIdentifier,
      paperclipIssueId: issueId,
      runId: flightKey,
      approved: true,
    });

    return reply.code(202).send({
      status: "approved-and-relaunched",
      issueId,
      runId: flightKey,
      persona: persona.registryId,
      queue: runQueue.isPersisted() ? "redis" : "inline",
    });
  });

  // ─── Telegram webhook ────────────────────────────────────────────────────
  // Accepts either:
  //   - The official Telegram Bot API update object (when set as the bot's
  //     webhook URL via BotFather), or
  //   - A simplified shape from external relays (n8n, custom bot wrapper):
  //       { message: string, chatId?: string|number, userId?: string,
  //         projectId?: string, taskDescription?: string }
  //
  // Auth: optional. If AICOS_TELEGRAM_SECRET env is set, requests must
  // present it as either `x-telegram-bot-api-secret-token` header (Telegram's
  // own header) or `x-aicos-secret` (for non-Telegram relays).
  //
  // Each accepted message kicks off /orchestrate with triggeredBy=telegram.
  // The default project is AICOS_DEFAULT_PROJECT_ID env or the orchestrate
  // body's projectId.
  const DEFAULT_PROJECT_ID = process.env.AICOS_DEFAULT_PROJECT_ID;
  const TELEGRAM_SECRET = process.env.AICOS_TELEGRAM_SECRET;

  const TelegramWebhookSchema = z.union([
    // Official Telegram Bot API shape (subset we care about)
    z.object({
      update_id: z.number(),
      message: z.object({
        text: z.string().min(1),
        chat: z.object({ id: z.number() }),
        from: z.object({ id: z.number(), username: z.string().optional() }).optional(),
      }),
    }),
    // Relay-style shape
    z.object({
      message: z.string().min(1),
      chatId: z.union([z.string(), z.number()]).optional(),
      userId: z.string().optional(),
      projectId: z.string().optional(),
    }),
  ]);

  app.post("/telegram/webhook", async (req, reply) => {
    if (!orchestrateAvailable) {
      return reply.code(503).send({ error: "orchestrator disabled — set AICOS_COMPANY_ID + paperclip creds" });
    }
    if (TELEGRAM_SECRET) {
      const headerSecret =
        (req.headers["x-telegram-bot-api-secret-token"] as string | undefined) ??
        (req.headers["x-aicos-secret"] as string | undefined);
      if (headerSecret !== TELEGRAM_SECRET) {
        return reply.code(401).send({ error: "missing or wrong shared secret" });
      }
    }
    const parsed = TelegramWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid webhook payload", details: parsed.error.flatten() });
    }

    // Normalize both shapes into the same fields.
    let message: string;
    let projectId: string | undefined;
    if ("update_id" in parsed.data) {
      message = parsed.data.message.text;
    } else {
      message = parsed.data.message;
      projectId = parsed.data.projectId;
    }
    const effectiveProjectId = projectId ?? DEFAULT_PROJECT_ID;
    if (!effectiveProjectId) {
      return reply.code(400).send({
        error: "no projectId — set AICOS_DEFAULT_PROJECT_ID env or include projectId in payload",
      });
    }

    const input: OrchestrateInput = {
      taskDescription: message,
      companyId: companyId!,
      projectId: effectiveProjectId,
      triggeredBy: "telegram",
    };
    const client = new PaperclipClient({
      apiUrl: opts.paperclipApiUrl!,
      apiKey: opts.paperclipApiKey!,
    });
    try {
      const result = await orchestrate(input, client);
      app.log.info(
        { subtasks: result.createdIssues.length, parent: result.parentIdentifier },
        "telegram-triggered orchestrate completed",
      );
      // Telegram requires fast 200 response — return short summary.
      return reply.code(202).send({
        status: "accepted",
        parentIdentifier: result.parentIdentifier,
        subtaskCount: result.createdIssues.length,
        subtasks: result.createdIssues.map((c) => ({
          identifier: c.identifier,
          role: c.role,
          blockedByPlanIds: c.blockedByPlanIds,
        })),
      });
    } catch (e) {
      app.log.error({ err: (e as Error).message }, "telegram orchestrate failed");
      return reply.code(500).send({ error: "orchestrate failed", details: (e as Error).message });
    }
  });

  app.post("/orchestrate", async (req, reply) => {
    if (!orchestrateAvailable) {
      return reply.code(503).send({
        error: "orchestrator disabled",
        reason: paperclipReady ? "missing AICOS_COMPANY_ID env" : "paperclip not configured",
      });
    }
    const parsed = OrchestrateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.flatten() });
    }
    const input: OrchestrateInput = {
      taskDescription: parsed.data.taskDescription,
      companyId: companyId!,
      projectId: parsed.data.projectId,
      parentIssueId: parsed.data.parentIssueId,
      defaultRole: parsed.data.defaultRole,
      triggeredBy: parsed.data.triggeredBy,
      parentTitle: parsed.data.parentTitle,
      parentAssigneeAgentId: parsed.data.parentAssigneeAgentId,
    };
    const client = new PaperclipClient({
      apiUrl: opts.paperclipApiUrl!,
      apiKey: opts.paperclipApiKey!,
    });
    try {
      const result = await orchestrate(input, client);
      app.log.info(
        {
          projectId: input.projectId,
          parentIssueId: input.parentIssueId,
          subtaskCount: result.createdIssues.length,
          atomic: result.decomposition.atomic,
          warningCount: result.warnings.length,
        },
        "orchestrated task",
      );
      return reply.code(202).send(result);
    } catch (e) {
      app.log.error({ err: (e as Error).message }, "orchestrate failed");
      return reply.code(500).send({ error: "orchestrate failed", details: (e as Error).message });
    }
  });

  // ─── Subtask promoter loop ───────────────────────────────────────────────
  // Promotes backlog subtasks to todo once their blockers are all done.
  if (orchestrateAvailable) {
    const stop = startSubtaskPromoter({
      apiUrl: opts.paperclipApiUrl!,
      apiKey: opts.paperclipApiKey!,
      companyId: companyId!,
    });
    app.addHook("onClose", async () => stop());
    app.log.info({ companyId, intervalMs: 5000 }, "subtask promoter started");
  } else {
    app.log.warn(
      { paperclipReady, companyIdConfigured: Boolean(companyId) },
      "subtask promoter NOT started — set AICOS_COMPANY_ID + paperclip credentials to enable",
    );
  }

  // ─── L4 Memory endpoints ─────────────────────────────────────────────────
  const MemoryStoreSchema = z.object({
    scope: z.enum(["agent", "project", "company", "market"]),
    text: z.string().min(1),
    summary: z.string().optional(),
    registryId: z.string().optional(),
    projectId: z.string().optional(),
    ticketId: z.string().optional(),
    ticketIdentifier: z.string().optional(),
    tags: z.array(z.string()).optional(),
  });

  app.post("/memory/store", async (req, reply) => {
    const r = MemoryStoreSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    const ok = await storeMemory(r.data);
    return { ok, scope: r.data.scope };
  });

  const MemorySearchSchema = z.object({
    query: z.string().min(1),
    scope: z.enum(["agent", "project", "company", "market", "knowledge", "all"]).optional(),
    registryId: z.string().optional(),
    projectId: z.string().optional(),
    limit: z.coerce.number().int().positive().max(20).optional(),
  });

  app.post("/memory/search", async (req, reply) => {
    const r = MemorySearchSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    const { query, scope, registryId, projectId, limit } = r.data;
    if (!scope || scope === "all") {
      return {
        items: await retrieveAllScopes(query, { registryId, projectId, perScopeLimit: limit ?? 3 }),
      };
    }
    return {
      items: await retrieveFromScope(scope as MemoryScope, query, {
        registryId,
        projectId,
        limit: limit ?? 5,
      }),
    };
  });

  // ─── Base de conocimiento (RAG) ──────────────────────────────────────────
  const KnowledgeIngestSchema = z.object({
    title: z.string().min(1),
    text: z.string().min(1),
    source: z.string().optional(),
    tags: z.array(z.string()).optional(),
    docId: z.string().optional(),
  });

  app.post("/knowledge/ingest", async (req, reply) => {
    const r = KnowledgeIngestSchema.safeParse(req.body);
    if (!r.success) {
      reply.code(400);
      return { error: "validation", details: r.error.issues };
    }
    const res = await ingestDocument(r.data);
    if (!res.ok) reply.code(422);
    return res;
  });

  app.get("/knowledge/list", async () => {
    return { documents: await listDocuments() };
  });

  app.delete("/knowledge/:docId", async (req) => {
    const { docId } = req.params as { docId: string };
    return await deleteDocument(decodeURIComponent(docId));
  });

  // ─── Reintentos inteligentes + escalado (#7) ─────────────────────────────
  // Lo postea el process-adapter (que corre en el container) al terminar un run,
  // para que el bridge host decida reintento/escalado. El path de la cola lo
  // llama in-process directamente.
  const RunFinishedSchema = z.object({
    issueId: z.string().min(1),
    identifier: z.string().optional(),
    disposition: z.enum(["completed", "failed", "empty", "held"]),
  });
  app.post("/internal/run-finished", async (req, reply) => {
    const r = RunFinishedSchema.safeParse(req.body);
    if (!r.success) { reply.code(400); return { error: "validation", details: r.error.issues }; }
    await recordRunOutcome(r.data.issueId, r.data.identifier, r.data.disposition as Disposition).catch(() => {});
    return { ok: true };
  });

  app.get("/retry/config", async () => ({ config: loadRetryConfig() }));
  app.post("/retry/config", async (req) => ({ config: saveRetryConfig((req.body ?? {}) as Parameters<typeof saveRetryConfig>[0]) }));
  app.get("/retry/state", async () => retryState());
  app.delete("/retry/:issueId", async (req) => {
    const { issueId } = req.params as { issueId: string };
    return { ok: clearRetry(decodeURIComponent(issueId)) };
  });

  // ─── Aging de tickets trabados (#8) ──────────────────────────────────────
  app.get("/aging/config", async () => ({ config: loadAgingConfig() }));
  app.post("/aging/config", async (req) => ({ config: saveAgingConfig((req.body ?? {}) as Parameters<typeof saveAgingConfig>[0]) }));
  app.get("/aging/scan", async () => await agingScan());

  // ─── Gate de tests (#9) ──────────────────────────────────────────────────
  app.get("/test-gate/config", async () => ({ config: loadTestGateConfig() }));
  app.post("/test-gate/config", async (req) => ({ config: saveTestGateConfig((req.body ?? {}) as Parameters<typeof saveTestGateConfig>[0]) }));

  // ─── Disparo de workflows n8n (#10) ──────────────────────────────────────
  const N8nFireSchema = z.object({
    trigger: z.string().optional(),
    url: z.string().url().optional(),
    method: z.enum(["GET", "POST"]).optional(),
    payload: z.unknown().optional(),
  });
  app.post("/n8n/trigger", async (req, reply) => {
    const r = N8nFireSchema.safeParse(req.body);
    if (!r.success) { reply.code(400); return { error: "validation", details: r.error.issues }; }
    const res = await fireN8n(r.data);
    if (!res.ok) reply.code(422);
    return res;
  });

  // ─── Daily standup del CEO ───────────────────────────────────────────────
  app.post("/standup/run", async () => {
    return await runStandup(true);
  });
  app.get("/standup/last", async () => {
    return { last: lastStandup() };
  });


  app.post(
    "/run",
    async (req: FastifyRequest, reply: FastifyReply) => {
      let parsed: RunRequestBody;
      try {
        parsed = RunRequestSchema.parse(req.body);
      } catch (e) {
        return reply.code(400).send({
          error: "invalid payload",
          details: (e as Error).message,
        });
      }

      const looksLikeTemplate = (v: string | undefined): boolean =>
        typeof v === "string" && (v.includes("{{") || v.startsWith("${"));

      const ctx = parsed.context as Record<string, unknown> | undefined;
      const ctxIssue = ctx?.paperclipIssue as Record<string, unknown> | undefined;
      const taskMarkdown = ctx?.paperclipTaskMarkdown as string | undefined;

      // Persona lookup desde el registry segun agentId que Paperclip nos pasa
      const persona = parsed.agentId
        ? resolvePersonaByPaperclipId(parsed.agentId)
        : null;

      // Workspace resolution:
      //   PRIORIDAD: registry/project-workspaces.json (paths del HOST).
      //   Paperclip inyecta paperclipWorkspace.cwd con paths internos del container
      //   (ej. "/paperclip/instances/.../projects/..."), que NO existen en el host
      //   donde corre el bridge. Si usamos esos cwd, spawn de hermes da exitCode 127
      //   (ENOENT). Asi que ignoramos paperclipWorkspace por completo para cwd y
      //   confiamos solo en nuestro map local.
      const ctxProjectId =
        (ctxIssue?.projectId as string | undefined) ??
        (ctx?.projectId as string | undefined);
      const workspace: ProjectWorkspace | null = ctxProjectId
        ? resolveWorkspaceByProjectId(ctxProjectId)
        : null;

      app.log.info(
        {
          bodyKeys: Object.keys(req.body as object),
          contextIssueId: ctx?.issueId,
          contextTaskId: ctx?.taskId,
          paperclipIssueKeys: ctxIssue ? Object.keys(ctxIssue) : null,
          hasTaskMarkdown: Boolean(taskMarkdown),
          taskMarkdownLen: taskMarkdown?.length ?? 0,
          personaRegistryId: persona?.registryId,
          personaName: persona?.agentName,
          personaCli: persona?.preferredModel?.cli,
          workspaceSource: workspace ? "registry" : "default-cwd",
          workspaceCwd: workspace?.cwd ?? null,
          workspaceProject: workspace?.projectName ?? null,
        },
        "payload structure",
      );

      let issueId: string | undefined =
        !looksLikeTemplate(parsed.issueId) ? parsed.issueId : undefined;
      if (!issueId && !looksLikeTemplate(parsed.ticketId))
        issueId = parsed.ticketId;
      if (!issueId && typeof ctx?.issueId === "string") issueId = ctx.issueId;
      if (!issueId && typeof ctxIssue?.id === "string") issueId = ctxIssue.id;

      let prompt: string | undefined =
        !looksLikeTemplate(parsed.prompt) ? parsed.prompt : undefined;

      // Determina cual API key Paperclip usar:
      //   1. Si el agente esta en el registry y tiene su token: usa ese
      //   2. Si no: usa el generico (AICOS Hermes) si esta configurado
      const apiKeyForCallbacks = persona?.apiKey ?? opts.paperclipApiKey;
      const apiUrlForCallbacks = opts.paperclipApiUrl;

      let pcClient: PaperclipClient | undefined;
      if (issueId && apiUrlForCallbacks && apiKeyForCallbacks) {
        pcClient = new PaperclipClient(
          {
            apiUrl: apiUrlForCallbacks,
            apiKey: apiKeyForCallbacks,
          },
          parsed.runId,
        );

        if (!prompt && taskMarkdown && taskMarkdown.trim().length > 0) {
          prompt = taskMarkdown.trim();
        }
        if (!prompt && ctxIssue) {
          const title = (ctxIssue.title as string) ?? "";
          const desc =
            (ctxIssue.description as string) ?? (ctxIssue.body as string) ?? "";
          prompt = `${title}\n\n${desc}`.trim();
        }
        if (!prompt) {
          try {
            const issue = await pcClient.getIssue(issueId);
            const title = issue.title ?? "";
            const desc = issue.description ?? issue.body ?? "";
            prompt = `${title}\n\n${desc}`.trim();
          } catch (e) {
            return reply.code(502).send({
              error: "paperclip getIssue failed",
              details: (e as Error).message,
            });
          }
        }
      }

      if (!prompt) {
        return reply.code(400).send({
          error:
            "no prompt provided (payload had only literal templates and no usable context)",
        });
      }

      const flightKey = parsed.runId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      tracker.start({
        runId: flightKey,
        persona: persona?.registryId,
        personaName: persona?.agentName,
        cli: persona?.preferredModel?.cli,
        model: persona?.preferredModel?.model,
        ticketIdentifier: ctxIssue?.identifier as string | undefined,
      });

      // Enqueue rather than setImmediate. The closure inside the queue's
      // executor rebuilds the PaperclipClient + workspace + persona from
      // the JSON-serializable job payload.
      await runQueue.enqueue({
        prompt: prompt!,
        model: parsed.model,
        provider: parsed.provider,
        personaRegistryId: persona?.registryId,
        workspaceProjectId: workspace?.projectName,
        ticketIdentifier: ctxIssue?.identifier as string | undefined,
        paperclipIssueId: issueId,
        runId: flightKey,
      });

      return reply.code(202).send({
        status: "accepted",
        issueId: issueId ?? null,
        runId: parsed.runId ?? null,
        persona: persona?.registryId ?? null,
        queue: runQueue.isPersisted() ? "redis" : "inline",
      });
    },
  );

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  return app;
}
