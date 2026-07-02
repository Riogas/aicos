/**
 * App Launcher (#12) — levantar/parar las apps generadas por los agentes.
 *
 * Escanea la carpeta de proyectos (la misma de /repos: ~/.config/aicos/
 * repos-config.json → root, default ~/Projects), detecta la tecnología de
 * cada app y expone start/stop/logs. v1 soporta apps con docker-compose
 * (la convención de los proyectos greenfield); las que no tienen compose se
 * listan igual con su stack detectado pero sin launcher.
 *
 * start corre `docker compose up -d --build` DETACHED (los builds tardan
 * minutos): el estado de la operación y su log quedan en
 * ~/.local/share/aicos/app-launcher/<slug>.log y se consultan por GET.
 */
import { spawn, execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, createWriteStream, statSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/home/riogas";
const REPOS_CFG = join(HOME, ".config", "aicos", "repos-config.json");
const OPS_DIR = join(HOME, ".local", "share", "aicos", "app-launcher");

function projectsRoot(): string {
  try {
    const d = JSON.parse(readFileSync(REPOS_CFG, "utf8")) as { root?: string; projectsRoot?: string };
    return d.root || d.projectsRoot || join(HOME, "Projects");
  } catch {
    return join(HOME, "Projects");
  }
}

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export interface AppInfo {
  slug: string;
  path: string;
  tech: string[];
  hasCompose: boolean;
  /** running | partial | stopped | building | error | no-launcher */
  status: string;
  services: Array<{ name: string; state: string; ports: string[] }>;
  urls: string[];
  lastOp?: { action: string; startedAt: string; running: boolean; exitCode?: number | null };
}

// ── Detección de stack ───────────────────────────────────────────────────────

function detectTech(dir: string): string[] {
  const tech: string[] = [];
  const has = (f: string) => existsSync(join(dir, f));
  if (COMPOSE_FILES.some(has)) tech.push("docker-compose");
  if (has("pnpm-workspace.yaml")) tech.push("pnpm-monorepo");
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) tech.push("next");
      else if (deps.react) tech.push("react");
      if (deps.fastify) tech.push("fastify");
      if (deps.express) tech.push("express");
      if (deps.prisma || deps["@prisma/client"]) tech.push("prisma");
      if (!tech.includes("next") && !tech.includes("react")) tech.push("node");
    } catch {
      tech.push("node");
    }
  }
  // monorepo: mirar también apps/*
  const appsDir = join(dir, "apps");
  if (existsSync(appsDir)) {
    try {
      for (const sub of readdirSync(appsDir).slice(0, 6)) {
        const p = join(appsDir, sub, "package.json");
        if (!existsSync(p)) continue;
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { dependencies?: Record<string, string> };
        const deps = pkg.dependencies ?? {};
        if (deps.next && !tech.includes("next")) tech.push("next");
        if (deps.fastify && !tech.includes("fastify")) tech.push("fastify");
        if ((deps.prisma || deps["@prisma/client"]) && !tech.includes("prisma")) tech.push("prisma");
      }
    } catch { /* best-effort */ }
  }
  if (existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml"))) tech.push("python");
  if (existsSync(join(dir, "go.mod"))) tech.push("go");
  if (existsSync(join(dir, "Cargo.toml"))) tech.push("rust");
  return [...new Set(tech)];
}

// ── Estado docker compose ────────────────────────────────────────────────────

function composePs(dir: string): Promise<AppInfo["services"]> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["compose", "ps", "--all", "--format", "json"],
      { cwd: dir, timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        const services: AppInfo["services"] = [];
        for (const line of stdout.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            const j = JSON.parse(t) as { Service?: string; State?: string; Publishers?: Array<{ PublishedPort?: number }> };
            const ports = (j.Publishers ?? [])
              .map((p) => p.PublishedPort)
              .filter((p): p is number => Boolean(p))
              .map(String);
            services.push({ name: j.Service ?? "?", state: j.State ?? "?", ports: [...new Set(ports)] });
          } catch { /* línea no-json */ }
        }
        resolve(services);
      },
    );
  });
}

// ── Operaciones (start/stop detached) ────────────────────────────────────────

interface Op {
  action: "start" | "stop";
  startedAt: string;
  proc: ReturnType<typeof spawn> | null;
  exitCode: number | null;
}

const ops = new Map<string, Op>(); // slug → última operación

function opLogPath(slug: string): string {
  return join(OPS_DIR, `${slug}.log`);
}

function runOp(slug: string, dir: string, action: "start" | "stop"): { ok: boolean; error?: string } {
  const cur = ops.get(slug);
  if (cur?.proc && cur.exitCode === null) return { ok: false, error: `ya hay una operación ${cur.action} en curso` };
  mkdirSync(OPS_DIR, { recursive: true });
  const log = createWriteStream(opLogPath(slug), { flags: "w" });
  const args =
    action === "start"
      ? ["compose", "up", "-d", "--build", "--remove-orphans"]
      : ["compose", "down"];
  log.write(`$ docker ${args.join(" ")}  (cwd=${dir})\n`);
  const proc = spawn("docker", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const op: Op = { action, startedAt: new Date().toISOString(), proc, exitCode: null };
  ops.set(slug, op);
  proc.stdout?.pipe(log, { end: false });
  proc.stderr?.pipe(log, { end: false });
  proc.on("exit", (code) => {
    op.exitCode = code ?? 1;
    op.proc = null;
    log.write(`\n[exit ${code}]\n`);
    log.end();
  });
  proc.on("error", (e) => {
    op.exitCode = 127;
    op.proc = null;
    log.write(`\nspawn error: ${e.message}\n`);
    log.end();
  });
  return { ok: true };
}

// ── API pública ──────────────────────────────────────────────────────────────

const HOST_IP = process.env.AICOS_PUBLIC_HOST || "192.168.2.33";

export async function listApps(): Promise<AppInfo[]> {
  const root = projectsRoot();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root).filter((d) => {
      if (d.startsWith(".")) return false;
      try { return statSync(join(root, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
  const out: AppInfo[] = [];
  for (const slug of dirs) {
    const path = join(root, slug);
    const tech = detectTech(path);
    if (tech.length === 0) continue; // carpeta sin nada reconocible
    const hasCompose = tech.includes("docker-compose");
    const op = ops.get(slug);
    const opRunning = Boolean(op?.proc && op.exitCode === null);
    let services: AppInfo["services"] = [];
    let status = "no-launcher";
    if (hasCompose) {
      services = await composePs(path);
      const up = services.filter((s) => s.state === "running").length;
      status =
        opRunning ? (op!.action === "start" ? "building" : "stopping")
        : up > 0 && up === services.length && services.length > 0 ? "running"
        : up > 0 ? "partial"
        : op?.exitCode ? "error"
        : "stopped";
    }
    const urls = services
      .flatMap((s) => s.ports)
      .filter((p, i, a) => a.indexOf(p) === i)
      .map((p) => `http://${HOST_IP}:${p}`);
    out.push({
      slug,
      path,
      tech,
      hasCompose,
      status,
      services,
      urls,
      lastOp: op
        ? { action: op.action, startedAt: op.startedAt, running: opRunning, exitCode: op.exitCode }
        : undefined,
    });
  }
  return out;
}

export function startApp(slug: string): { ok: boolean; error?: string } {
  const dir = join(projectsRoot(), slug);
  if (!COMPOSE_FILES.some((f) => existsSync(join(dir, f)))) {
    return { ok: false, error: "la app no tiene docker-compose — levantala a mano o agregale uno" };
  }
  return runOp(slug, dir, "start");
}

export function stopApp(slug: string): { ok: boolean; error?: string } {
  const dir = join(projectsRoot(), slug);
  if (!COMPOSE_FILES.some((f) => existsSync(join(dir, f)))) {
    return { ok: false, error: "la app no tiene docker-compose" };
  }
  return runOp(slug, dir, "stop");
}

/** Log de la última operación + logs recientes de los servicios. */
export function appLogs(slug: string): Promise<{ op: string; services: string }> {
  const dir = join(projectsRoot(), slug);
  let opLog = "";
  try { opLog = readFileSync(opLogPath(slug), "utf8").slice(-8000); } catch { /* sin ops aún */ }
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["compose", "logs", "--tail", "80", "--no-color"],
      { cwd: dir, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (_err, stdout) => resolve({ op: opLog, services: (stdout ?? "").slice(-12_000) }),
    );
  });
}
