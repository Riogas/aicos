import { spawn } from "node:child_process";
import { z } from "zod";

/**
 * Action handlers. Each takes a validated input and returns a result.
 * Side-effect actions can be deferred behind PolicyDecision=require_approval.
 *
 * NB: This is a minimum-viable skeleton. Production deployment would split
 * tools into separate modules and add per-tool auth (GitHub token, Docker
 * socket access, etc.).
 */

export const actorSchema = z.object({
  id: z.string(),
  registryId: z.string().optional(),
  companyId: z.string().optional(),
});

// ─── GitHub ────────────────────────────────────────────────────────────────
export const githubIssueSchema = z.object({
  actor: actorSchema,
  owner: z.string(),
  repo: z.string(),
  title: z.string(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  dryRun: z.boolean().optional().default(true),
});

export async function createGithubIssue(input: z.infer<typeof githubIssueSchema>) {
  const token = process.env.GITHUB_TOKEN;
  if (input.dryRun || !token) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        url: `https://github.com/${input.owner}/${input.repo}/issues/new`,
        title: input.title,
        bodyLength: input.body?.length ?? 0,
        labels: input.labels ?? [],
      },
      note: token ? "dryRun=true" : "GITHUB_TOKEN unset — would have run dry-run anyway",
    };
  }
  const url = `https://api.github.com/repos/${input.owner}/${input.repo}/issues`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      labels: input.labels,
    }),
  });
  const data = res.ok ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data };
}

// ─── Docker ────────────────────────────────────────────────────────────────
export const dockerSchema = z.object({
  actor: actorSchema,
  cmd: z.enum(["ps", "logs", "inspect", "stats"]),
  containerName: z.string().optional(),
  tailLines: z.number().int().positive().max(500).optional().default(50),
});

export async function runDockerCmd(input: z.infer<typeof dockerSchema>) {
  // Whitelist: only read-only commands. No rm/start/stop/exec.
  const args: string[] = [input.cmd];
  if (input.cmd === "logs") {
    if (!input.containerName) return { ok: false, error: "containerName required for logs" };
    args.push("--tail", String(input.tailLines), input.containerName);
  } else if (input.cmd === "inspect") {
    if (!input.containerName) return { ok: false, error: "containerName required for inspect" };
    args.push(input.containerName);
  } else if (input.cmd === "stats") {
    args.push("--no-stream");
    if (input.containerName) args.push(input.containerName);
  } else if (input.cmd === "ps") {
    args.push("--format", "json");
  }
  return runShell("docker", args, 10_000);
}

// ─── Browser (web fetch) ───────────────────────────────────────────────────
export const browserSchema = z.object({
  actor: actorSchema,
  url: z.string().url(),
  method: z.enum(["GET", "HEAD"]).optional().default("GET"),
  asText: z.boolean().optional().default(true),
});

export async function runBrowserFetch(input: z.infer<typeof browserSchema>) {
  // SSRF guard: deny private IPs.
  const u = new URL(input.url);
  const host = u.hostname.toLowerCase();
  const blocked = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254", // EC2 metadata
  ];
  if (blocked.includes(host) || host.endsWith(".internal") || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) {
    return { ok: false, error: "SSRF guard: private/internal host blocked", host };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(input.url, {
      method: input.method,
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    const body = input.asText ? (await res.text()).slice(0, 50_000) : undefined;
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
      body,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── Shell (very restricted — read-only commands) ──────────────────────────
const SHELL_ALLOWLIST = ["ls", "cat", "head", "tail", "wc", "git status", "git log", "git diff"] as const;

export const shellSchema = z.object({
  actor: actorSchema,
  cmd: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(15_000).optional().default(5000),
});

export async function runShellCmd(input: z.infer<typeof shellSchema>) {
  const trimmed = input.cmd.trim();
  const allowed = SHELL_ALLOWLIST.some((prefix) => trimmed.startsWith(prefix));
  if (!allowed) {
    return {
      ok: false,
      error: `Shell command not in allowlist. Allowed prefixes: ${SHELL_ALLOWLIST.join(", ")}`,
    };
  }
  // No shell expansion — split words.
  const parts = trimmed.split(/\s+/);
  const program = parts[0]!;
  const args = parts.slice(1);
  return runShell(program, args, input.timeoutMs, input.cwd);
}

// ─── Internal helper ───────────────────────────────────────────────────────
function runShell(
  program: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<{ ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let killed = false;
    const proc = spawn(program, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      timeout: timeoutMs,
    });
    proc.stdout.on("data", (c) => (stdout += c.toString("utf-8")));
    proc.stderr.on("data", (c) => (stderr += c.toString("utf-8")));
    proc.on("error", (err: NodeJS.ErrnoException) =>
      resolve({
        ok: false,
        exitCode: err.code === "ENOENT" ? 127 : 1,
        error: err.message,
      }),
    );
    proc.on("exit", (code, signal) => {
      const t = Date.now() - start;
      resolve({
        ok: !killed && code === 0,
        exitCode: signal ? 1 : code ?? 1,
        stdout: stdout.slice(0, 30_000),
        stderr: stderr.slice(0, 5000),
        ...(t > timeoutMs - 500 ? { error: `timeout ${timeoutMs}ms` } : {}),
      });
    });
  });
}
