/**
 * Subtask promoter — background loop in the bridge.
 *
 * Three responsibilities per tick:
 *
 *   1) PROMOTE — find backlog issues whose blockers are all done/cancelled
 *      and PATCH them to 'todo' so Paperclip's dispatcher picks them up.
 *      Why we own this: vendor Paperclip's initial-dispatch path does NOT
 *      honor issue_relations.blocks (only the wake-recovery path does), so
 *      keeping subtasks in 'backlog' until ready is the only way to enforce
 *      true sequential / parallel execution.
 *
 *   2) CONTEXT — before promoting a subtask, fetch the final comment of
 *      each completed blocker (= the previous agent's actual output) and
 *      prepend it to the subtask's description. Without this, agent N+1
 *      reads only its OWN ticket description and works blind to what
 *      agent N produced. With it, architect reads the analyst's spec,
 *      implementer reads the architect's plan, reviewer reads the diff
 *      summary, etc.
 *
 *   3) RECONCILE PARENT — for each parent issue still in_progress, if all
 *      its children are done/cancelled, mark the parent done. Without this,
 *      auto-created orchestrator parents (the [telegram] ones) stay open
 *      forever even when the work is finished.
 *
 * Errors in any single step never abort the loop — they're logged.
 */

import { PaperclipClient } from "./paperclip-client.js";
import { clearParentHeartbeat } from "./orchestrator.js";

const PROMOTE_INTERVAL_MS = 5_000;
const PROMOTE_QUERY_TIMEOUT_MS = 4_000;

export interface PromoterOptions {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  /** How often to scan. Defaults to 5s. */
  intervalMs?: number;
  /** Called with the list of just-promoted issue ids per tick. */
  onPromote?: (promoted: PromotedIssue[]) => void;
}

export interface PromotedIssue {
  id: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  blockedBy: Array<{ id: string; identifier: string | null; status: string }>;
}

interface BacklogReadyResp {
  items: Array<{
    id: string;
    identifier: string | null;
    title: string;
    description?: string | null;
    assigneeAgentId: string | null;
    blockedBy?: Array<{ id: string; identifier?: string | null; status?: string }>;
  }>;
}

interface ParentCandidate {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
}

interface ParentListResp {
  items: ParentCandidate[];
}

/** Strip well-known boilerplate the bridge itself posted at the end of every run. */
const SYSTEM_COMMENT_MARKERS = [
  "agent completed successfully",
  "agent run failed",
  "ejecucion fallo",
];

function isSystemComment(body: string): boolean {
  const lower = body.trim().toLowerCase();
  return SYSTEM_COMMENT_MARKERS.some((m) => lower.startsWith(m));
}

/**
 * For a single blocker issue id, return the agent's final report comment
 * (skipping the system "Agent completed successfully" marker). Returns
 * null if no usable comment is found.
 */
async function fetchBlockerOutput(
  client: PaperclipClient,
  issueId: string,
): Promise<{ body: string; authorAgentId: string | null; ts?: string } | null> {
  try {
    const comments = await client.getComments(issueId);
    // Walk newest-first looking for a substantial agent comment.
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i]!;
      if (!c.body || c.body.trim().length === 0) continue;
      if (isSystemComment(c.body)) continue;
      return { body: c.body, authorAgentId: c.authorAgentId ?? null, ts: c.createdAt };
    }
    return null;
  } catch (e) {
    process.stderr.write(`[promoter] fetchBlockerOutput(${issueId}) warn: ${(e as Error).message}\n`);
    return null;
  }
}

/**
 * Build the enriched description: blocker outputs first (oldest → newest),
 * separator, then the original ticket description.
 *
 * Idempotent guard: if originalDescription already contains the marker
 * "## Context from previous step(s)" we assume enrichment already happened
 * and skip — so re-promotion attempts don't pile context blocks on top of
 * each other.
 */
function buildEnrichedDescription(
  originalDescription: string,
  blockers: Array<{
    identifier: string | null;
    title: string;
    output: { body: string; authorAgentId: string | null } | null;
  }>,
): string | null {
  if (originalDescription.includes("## Context from previous step")) return null;
  const usable = blockers.filter((b) => b.output && b.output.body.trim().length > 0);
  if (usable.length === 0) return null;

  const blocks = usable.map((b) => {
    const authorTag = b.output?.authorAgentId
      ? `agent ${b.output.authorAgentId.slice(0, 8)}`
      : "previous agent";
    return [
      `### From ${b.identifier ?? "?"} — ${b.title}`,
      `_(${authorTag})_`,
      ``,
      b.output!.body.trim(),
    ].join("\n");
  });

  return [
    `## Context from previous step(s)`,
    ``,
    blocks.join("\n\n---\n\n"),
    ``,
    `---`,
    ``,
    `## Your task`,
    ``,
    originalDescription,
  ].join("\n");
}

/**
 * Find backlog issues that are READY to promote (all blockers done/cancelled).
 * Returns each candidate with its FULL blocker list (so the promoter can fetch
 * each blocker's final comment to build the context block).
 */
async function findReadyBacklog(
  apiUrl: string,
  apiKey: string,
  companyId: string,
): Promise<Array<PromotedIssue & { description: string }>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROMOTE_QUERY_TIMEOUT_MS);
  try {
    const listUrl = `${apiUrl}/api/companies/${companyId}/issues?status=backlog&includeBlockedBy=true`;
    const r = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      process.stderr.write(`[promoter] list backlog HTTP ${r.status}\n`);
      return [];
    }
    const data = (await r.json()) as BacklogReadyResp | { items?: BacklogReadyResp["items"] };
    const candidates = Array.isArray((data as BacklogReadyResp).items)
      ? (data as BacklogReadyResp).items
      : (Array.isArray(data) ? (data as unknown as BacklogReadyResp["items"]) : []);
    if (!candidates.length) return [];

    const ready: Array<PromotedIssue & { description: string }> = [];
    for (const c of candidates) {
      const blockers = c.blockedBy ?? [];
      const unfinished = blockers.filter(
        (b) => b.status && b.status !== "done" && b.status !== "cancelled",
      );
      if (unfinished.length === 0) {
        ready.push({
          id: c.id,
          identifier: c.identifier ?? null,
          title: c.title,
          description: c.description ?? "",
          assigneeAgentId: c.assigneeAgentId ?? null,
          blockedBy: blockers.map((b) => ({
            id: b.id,
            identifier: b.identifier ?? null,
            status: b.status ?? "?",
          })),
        });
      }
    }
    return ready;
  } catch (e) {
    process.stderr.write(`[promoter] scan failed: ${(e as Error).message}\n`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * List candidate parent issues — anything in_progress OR blocked. We have to
 * include `blocked` because the long-running orchestrator parents (which
 * have no agent adapter assigned to them, they're tracking-only) routinely
 * get escalated to blocked by Paperclip's watchdog while their children
 * are still working. Without that we'd never close them.
 */
async function listCandidateParents(
  apiUrl: string,
  apiKey: string,
  companyId: string,
): Promise<ParentCandidate[]> {
  // Paperclip's list endpoint only accepts a single status, so we make two calls.
  const fetchList = async (status: string): Promise<ParentCandidate[]> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROMOTE_QUERY_TIMEOUT_MS);
    try {
      const url = `${apiUrl}/api/companies/${companyId}/issues?status=${status}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!r.ok) return [];
      const data = (await r.json()) as ParentListResp | { items?: ParentCandidate[] };
      const items = Array.isArray((data as ParentListResp).items)
        ? (data as ParentListResp).items
        : (Array.isArray(data) ? (data as unknown as ParentCandidate[]) : []);
      return items;
    } catch {
      return [];
    } finally {
      clearTimeout(t);
    }
  };
  const [a, b] = await Promise.all([fetchList("in_progress"), fetchList("blocked")]);
  return [...a, ...b];
}

/**
 * For each in_progress issue with children: if every child is done/cancelled,
 * mark the parent done. Skips parents that look like orphans (no children).
 */
async function reconcileParents(
  client: PaperclipClient,
  apiUrl: string,
  apiKey: string,
  companyId: string,
): Promise<string[]> {
  const closed: string[] = [];
  const parents = await listCandidateParents(apiUrl, apiKey, companyId);
  for (const p of parents) {
    let children;
    try {
      children = await client.listChildren(companyId, p.id);
    } catch (e) {
      process.stderr.write(`[parent-reconcile] listChildren(${p.identifier ?? p.id}) warn: ${(e as Error).message}\n`);
      continue;
    }
    if (children.length === 0) continue; // not a parent
    const allDone = children.every((c) => c.status === "done" || c.status === "cancelled");
    if (!allDone) continue;
    try {
      await client.patchStatus(p.id, "done");
      closed.push(p.identifier ?? p.id);
      clearParentHeartbeat(p.id);
      process.stderr.write(
        `[parent-reconcile] closed parent ${p.identifier ?? p.id} (all ${children.length} children done)\n`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      // When Paperclip's watchdog already escalated the parent, it stamps a
      // recoveryAction owned by an account we don't control. The error is a
      // 403 with this exact text. We can't resolve those without escalation,
      // so just log it once-per-tick and move on rather than spamming.
      if (msg.includes("recovery action")) {
        process.stderr.write(
          `[parent-reconcile] ${p.identifier ?? p.id} blocked by watchdog recovery action — skipping (will need manual close)\n`,
        );
      } else {
        process.stderr.write(
          `[parent-reconcile] patchStatus(${p.identifier ?? p.id},done) fail: ${msg}\n`,
        );
      }
    }
  }
  return closed;
}

/**
 * Start the promoter loop. Returns a stop() function.
 *
 * Best-effort: errors don't abort the loop, they get logged.
 */
export function startSubtaskPromoter(opts: PromoterOptions): () => void {
  const client = new PaperclipClient({ apiUrl: opts.apiUrl, apiKey: opts.apiKey });
  let stopped = false;
  const interval = opts.intervalMs ?? PROMOTE_INTERVAL_MS;

  const tick = async () => {
    if (stopped) return;
    try {
      // Step 1+2: find ready backlog, enrich descriptions with blocker output,
      //          promote to 'todo'.
      const ready = await findReadyBacklog(opts.apiUrl, opts.apiKey, opts.companyId);
      const promoted: PromotedIssue[] = [];
      for (const r of ready) {
        try {
          // Build context block from blocker outputs (oldest → newest).
          const blockerOutputs: Array<{
            identifier: string | null;
            title: string;
            output: { body: string; authorAgentId: string | null } | null;
          }> = [];
          for (const b of r.blockedBy) {
            const output = await fetchBlockerOutput(client, b.id);
            blockerOutputs.push({
              identifier: b.identifier,
              title: "", // we don't have the blocker title in the list response — keep it short
              output,
            });
          }

          const enriched = buildEnrichedDescription(r.description, blockerOutputs);
          if (enriched) {
            await client.patchDescription(r.id, enriched);
            process.stderr.write(
              `[promoter] enriched description of ${r.identifier ?? r.id} with ${blockerOutputs.filter((b) => b.output).length}/${r.blockedBy.length} blocker output(s)\n`,
            );
          }

          await client.patchStatus(r.id, "todo");
          promoted.push({
            id: r.id,
            identifier: r.identifier,
            title: r.title,
            assigneeAgentId: r.assigneeAgentId,
            blockedBy: r.blockedBy,
          });
        } catch (e) {
          process.stderr.write(`[promoter] patchStatus(${r.identifier ?? r.id}) fail: ${(e as Error).message}\n`);
        }
      }
      if (promoted.length > 0) {
        process.stderr.write(
          `[promoter] promoted ${promoted.length} backlog→todo: ${promoted.map((p) => p.identifier ?? p.id).join(", ")}\n`,
        );
        opts.onPromote?.(promoted);
      }

      // Step 3: close parents whose children are all done.
      await reconcileParents(client, opts.apiUrl, opts.apiKey, opts.companyId);
    } catch (e) {
      process.stderr.write(`[promoter] tick error: ${(e as Error).message}\n`);
    }
  };

  // Fire-and-forget initial tick + repeating timer.
  void tick();
  const handle = setInterval(() => void tick(), interval);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
