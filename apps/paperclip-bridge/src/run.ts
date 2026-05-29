import { runHermesOneshotCaptured } from "./hermes.js";
import { PaperclipClient } from "./paperclip-client.js";

export interface ExecuteRunInput {
  prompt: string;
  model?: string;
  provider?: string;
  paperclip?: {
    client: PaperclipClient;
    issueId: string;
  };
}

export interface ExecuteRunResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

/**
 * Logica unica de "ejecutar una tarea" compartida entre CLI mode y server mode.
 * Si hay context de Paperclip, marca in_progress -> ejecuta -> postea comment +
 * marca done/failed.
 */
export async function executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
  const start = Date.now();
  const pc = input.paperclip;

  if (pc) {
    try {
      await pc.client.updateStatus(pc.issueId, "in_progress");
    } catch (e) {
      process.stderr.write(`updateStatus(in_progress) warn: ${(e as Error).message}\n`);
    }
  }

  const { exitCode, stdout, stderr } = await runHermesOneshotCaptured({
    prompt: input.prompt,
    model: input.model,
    provider: input.provider,
  });

  const durationMs = Date.now() - start;
  const output = stdout.trim();

  if (pc) {
    const finalStatus: "done" | "failed" = exitCode === 0 ? "done" : "failed";
    const commentBody =
      exitCode === 0
        ? output ||
          "(Hermes termino correctamente pero sin output. Posible task tipo no-op.)"
        : `**Hermes fallo** (exit ${exitCode})\n\n` +
          (output ? `\`\`\`\n${output}\n\`\`\`\n\n` : "") +
          (stderr.trim()
            ? `**stderr**\n\`\`\`\n${stderr.trim().slice(0, 4000)}\n\`\`\``
            : "");

    try {
      await pc.client.postComment(pc.issueId, commentBody);
    } catch (e) {
      process.stderr.write(`postComment warn: ${(e as Error).message}\n`);
    }
    try {
      await pc.client.updateStatus(pc.issueId, finalStatus);
    } catch (e) {
      process.stderr.write(`updateStatus(${finalStatus}) warn: ${(e as Error).message}\n`);
    }
    // Best-effort cost reporting (R4 lo hara como ciudadano de primera)
    void pc.client.reportCost(pc.issueId, {});
  }

  return { exitCode, output, durationMs };
}
