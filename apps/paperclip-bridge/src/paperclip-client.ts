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

  async postComment(issueId: string, body: string): Promise<void> {
    const url = `${this.cfg.apiUrl}${COMMENTS_PATH(issueId)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `paperclip.postComment(${issueId}): ${res.status} ${res.statusText} ${txt}`,
      );
    }
  }

  async updateStatus(issueId: string, status: IssueStatus): Promise<void> {
    const url = `${this.cfg.apiUrl}${ISSUE_PATH(issueId)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
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
