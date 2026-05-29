import { spawn } from "node:child_process";

export interface OneshotOptions {
  prompt: string;
  model?: string;
  provider?: string;
}

export interface OneshotCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function buildArgs(opts: OneshotOptions): string[] {
  const args: string[] = ["-z", opts.prompt];
  if (opts.model) args.push("-m", opts.model);
  if (opts.provider) args.push("--provider", opts.provider);
  return args;
}

/**
 * Modo "live": stdio del subprocess enchufado directo al del bridge.
 * Util en CLI mode (terminal interactiva).
 */
export function runHermesOneshot(opts: OneshotOptions): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("hermes", buildArgs(opts), {
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        process.stderr.write(
          "aicos-bridge: 'hermes' no encontrado en PATH.\n",
        );
        resolve(127);
        return;
      }
      process.stderr.write(`aicos-bridge: spawn hermes fallo: ${err.message}\n`);
      resolve(1);
    });
    proc.on("exit", (code, signal) => {
      resolve(signal ? 1 : code ?? 1);
    });
  });
}

/**
 * Modo "captured": acumula stdout/stderr en memoria. Util en server mode
 * para postear el resultado completo a Paperclip.
 *
 * IMPORTANTE: prompts largos pueden generar outputs grandes. Para >1MB
 * habria que streamear via callback en vez de concatenar.
 */
export function runHermesOneshotCaptured(
  opts: OneshotOptions,
): Promise<OneshotCaptureResult> {
  return new Promise((resolve) => {
    const proc = spawn("hermes", buildArgs(opts), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      const exitCode = err.code === "ENOENT" ? 127 : 1;
      resolve({
        exitCode,
        stdout,
        stderr: `${stderr}\nspawn err: ${err.message}`,
      });
    });

    proc.on("exit", (code, signal) => {
      resolve({
        exitCode: signal ? 1 : code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
