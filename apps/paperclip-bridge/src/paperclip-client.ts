/**
 * Cliente REST minimalista para la API de Paperclip.
 *
 * NOTA: las rutas exactas no estan en docs publicas; las inferi del modelo
 * de issues/comments y del README. La primera vez que probemos vamos a
 * confirmar contra el server real e iterar si Paperclip usa paths distintos.
 *
 * Auth: Bearer token (Better-Auth API key del agente).
 */

export interface PaperclipConfig {
  apiUrl: string;
  apiKey: string;
}

export interface PaperclipIssue {
  id: string;
  title?: string;
  description?: string;
  body?: string;
  status?: string;
  [key: string]: unknown;
}

export type IssueStatus = "in_progress" | "done" | "failed" | "blocked";

/**
 * Comment presentation shape per Paperclip's issueCommentPresentationSchema.
 * Valid kinds: "message" (regular agent reply) or "system_notice" (status update).
 * Tones: "neutral" | "info" | "success" | "warning" | "danger".
 */
export interface CommentPresentation {
  kind?: "message" | "system_notice";
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  title?: string | null;
  detailsDefaultOpen?: boolean;
}

/**
 * Comment metadata per Paperclip's issueCommentMetadataSchema.
 * Used to attach structured key/value rows visible in the Paperclip UI.
 */
export type CommentMetadataRow =
  | { type: "text"; label?: string | null; text: string }
  | { type: "code"; label?: string | null; code: string; language?: string | null }
  // Paperclip schema is strict: ONE key/value per row, label = key.
  | { type: "key_value"; label: string; value: string };

export interface CommentMetadataSection {
  title?: string | null;
  rows: CommentMetadataRow[];
}

export interface CommentMetadata {
  version: 1;
  sourceRunId?: string | null;
  sections: CommentMetadataSection[];
}

const COST_REPORTING_PATH = "/api/cost-events";
const COMMENTS_PATH = (issueId: string) => `/api/issues/${issueId}/comments`;
const ISSUE_PATH = (issueId: string) => `/api/issues/${issueId}`;

export class PaperclipClient {
  /**
   * runId opcional — cuando esta presente, se envia como header
   * `x-paperclip-run-id` (requerido por Paperclip auth middleware
   * para mutaciones de agente; ver server/src/middleware/auth.ts:36).
   */
  constructor(
    private readonly cfg: PaperclipConfig,
    private readonly runId?: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const base: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      Accept: "application/json",
      ...extra,
    };
    if (this.runId) base["x-paperclip-run-id"] = this.runId;
    return base;
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    const url = `${this.cfg.apiUrl}${ISSUE_PATH(issueId)}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `paperclip.getIssue(${issueId}): ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as PaperclipIssue;
  }

  async postComment(
    issueId: string,
    body: string,
    opts?: {
      presentation?: CommentPresentation;
      metadata?: CommentMetadata;
    },
  ): Promise<void> {
    const url = `${this.cfg.apiUrl}${COMMENTS_PATH(issueId)}`;
    const payload: Record<string, unknown> = { body };
    if (opts?.presentation) payload.presentation = opts.presentation;
    if (opts?.metadata) payload.metadata = opts.metadata;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      // If Paperclip rejects the enriched payload (schema mismatch on this
      // vendor version), retry without optional fields so we still get the
      // comment recorded. This keeps the bridge tolerant to vendor upgrades.
      if (res.status === 400 && (opts?.presentation || opts?.metadata)) {
        process.stderr.write(
          `paperclip.postComment(${issueId}) schema mismatch, retrying without presentation/metadata\n`,
        );
        const retry = await fetch(url, {
          method: "POST",
          headers: this.headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ body }),
        });
        if (retry.ok) return;
        const rt = await retry.text().catch(() => "");
        throw new Error(
          `paperclip.postComment(${issueId}) retry: ${retry.status} ${retry.statusText} ${rt}`,
        );
      }
      throw new Error(
        `paperclip.postComment(${issueId}): ${res.status} ${res.statusText} ${txt}`,
      );
    }
  }

  async updateStatus(issueId: string, status: IssueStatus): Promise<void> {
    const url = `${this.cfg.apiUrl}${ISSUE_PATH(issueId)}`;
    // We send status + an explicit comment marker. updateIssueSchema doesn't
    // accept nextAction/disposition fields (those live on recovery actions),
    // so we keep the body minimal and rely on the rich postComment above to
    // signal completion semantics. The `comment` field IS accepted by the
    // schema and shows up in the issue's activity log.
    const completionMessage =
      status === "done"
        ? "Agent completed successfully."
        : status === "blocked"
          ? "Agent run failed — assistance required."
          : null;
    const payload: Record<string, unknown> = { status };
    if (completionMessage) payload.comment = completionMessage;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      if (res.status === 400) {
        // Retry without the comment field if vendor doesn't accept it
        process.stderr.write(
          `paperclip.updateStatus(${issueId},${status}) schema mismatch, retrying status-only\n`,
        );
        const retry = await fetch(url, {
          method: "PATCH",
          headers: this.headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ status }),
        });
        if (retry.ok) return;
        const rt = await retry.text().catch(() => "");
        throw new Error(
          `paperclip.updateStatus retry: ${retry.status} ${retry.statusText} ${rt}`,
        );
      }
      throw new Error(
        `paperclip.updateStatus(${issueId}, ${status}): ${res.status} ${res.statusText} ${txt}`,
      );
    }
  }

  /**
   * Soft-fail: si el endpoint no existe en esta version de Paperclip,
   * loggeamos y seguimos. El costo eventualmente se manejara via Quota
   * Manager (R4) — esto es best-effort.
   */
  async reportCost(
    issueId: string,
    payload: {
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      model?: string;
      provider?: string;
    },
  ): Promise<void> {
    const url = `${this.cfg.apiUrl}${COST_REPORTING_PATH}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ issueId, ...payload }),
      });
      if (!res.ok && res.status !== 404) {
        process.stderr.write(
          `paperclip.reportCost(${issueId}) WARN: ${res.status}\n`,
        );
      }
    } catch (e) {
      process.stderr.write(
        `paperclip.reportCost(${issueId}) WARN: ${(e as Error).message}\n`,
      );
    }
  }
}
