import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
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
import {
  storeMemory,
  retrieveFromScope,
  retrieveAllScopes,
  type MemoryScope,
} from "./memory.js";
import { orchestrate, type OrchestrateInput } from "./orchestrator.js";
import { startSubtaskPromoter } from "./subtask-promoter.js";
import { InFlightTracker, type TrackerEvent, type RunStage } from "./in-flight-tracker.js";

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
  const tracker = new InFlightTracker();
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
    scope: z.enum(["agent", "project", "company", "market", "all"]).optional(),
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

      setImmediate(async () => {
        try {
          const result = await executeRun({
            prompt: prompt!,
            model: parsed.model,
            provider: parsed.provider,
            persona: persona ?? undefined,
            workspace,
            ticketIdentifier: (ctxIssue?.identifier as string | undefined),
            paperclip:
              pcClient && issueId
                ? { client: pcClient, issueId }
                : undefined,
            quotaClient,
            learningClient,
            policyClient,
            tracker,
            runId: flightKey,
          });
          app.log.info(
            {
              issueId,
              runId: parsed.runId,
              persona: persona?.registryId,
              mode: result.mode,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              outputLen: result.output.length,
            },
            "run completed",
          );
        } catch (e) {
          app.log.error(
            { err: (e as Error).message, issueId, runId: parsed.runId },
            "run failed",
          );
        } finally {
          tracker.setStage(flightKey, "done");
        }
      });

      return reply.code(202).send({
        status: "accepted",
        issueId: issueId ?? null,
        runId: parsed.runId ?? null,
        persona: persona?.registryId ?? null,
      });
    },
  );

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  return app;
}
