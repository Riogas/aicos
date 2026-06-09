/**
 * Subtask promoter — background loop in the bridge that watches for
 * AICOS-managed subtasks in status='backlog' whose blockers are all done,
 * and promotes them to 'todo' so Paperclip's regular dispatcher picks them up.
 *
 * Why we own the promotion instead of Paperclip:
 *   Paperclip's vendor dispatcher does NOT honor issue_relations.blocks at the
 *   initial dispatch path (only in the wake-recovery path). So if we created
 *   3 child issues all in 'todo' with blocks relations between them, Paperclip
 *   would dispatch all 3 at once. By keeping them in 'backlog' and promoting
 *   only when blockers complete, we get true sequential / parallel execution.
 *
 * Loop:
 *   every PROMOTE_INTERVAL_MS, run a single SQL query that finds all
 *   backlog issues whose blockers are all in (done, cancelled), then PATCH each
 *   to status='todo'. We rely on Paperclip's REST PATCH so the activity log
 *   and any consumers see the transition normally.
 */

import { PaperclipClient } from "./paperclip-client.js";

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
}

interface BacklogReadyResp {
  items: Array<{
    id: string;
    identifier: string | null;
    title: string;
    assigneeAgentId: string | null;
    blockedBy?: Array<{ id: string; status?: string }>;
  }>;
}

/**
 * Asks Paperclip for ALL issues in our company that are status='backlog' AND
 * whose every blocker (if any) is in (done, cancelled). This avoids a SQL
 * dependency in the bridge — Paperclip already speaks REST and knows blocks.
 *
 * Vendor Paperclip doesn't have a single endpoint for "ready backlog" — we
 * filter locally using the /issues list with a status filter, then prune by
 * checking issue.relations.blockedBy server-side per issue.
 *
 * For the MVP, we do a single broad list call and then GET on each candidate
 * to inspect blockers. Acceptable up to ~50 backlog issues; if it grows we
 * push a dedicated endpoint later.
 */
async function findReadyBacklog(
  client: PaperclipClient,
  apiUrl: string,
  apiKey: string,
  companyId: string,
): Promise<PromotedIssue[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROMOTE_QUERY_TIMEOUT_MS);
  try {
    // 1. list backlog candidates with their blockedBy relations inlined.
    // NOTE: Paperclip's list endpoint accepts ?status=<single> not ?statusIn=<csv>.
    // statusIn is silently ignored and returns ALL issues, which would make the
    // promoter try to "promote" already-running tickets.
    // includeBlockedBy=true saves us a follow-up GET per candidate.
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

    // 2. blockers are inlined on the list response thanks to includeBlockedBy=true.
    // Issue is "ready" when blockedBy is empty OR every blocker is done/cancelled.
    const ready: PromotedIssue[] = [];
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
          assigneeAgentId: c.assigneeAgentId ?? null,
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
      const ready = await findReadyBacklog(client, opts.apiUrl, opts.apiKey, opts.companyId);
      if (ready.length === 0) return;
      const promoted: PromotedIssue[] = [];
      for (const r of ready) {
        try {
          await client.patchStatus(r.id, "todo");
          promoted.push(r);
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
