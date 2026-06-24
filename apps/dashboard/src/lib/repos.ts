/**
 * Explorador de repos/apps. Escanea una carpeta raíz configurable y detecta las
 * subcarpetas que son repos (.git) o apps (manifests). Config en
 * ~/.config/aicos/repos-config.json (mismo home montado que ven los agentes, así
 * los paths sirven dentro del container).
 */
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";

const HOME = process.env.AICOS_HOST_HOME || process.env.HOME || "/home/vagrant";
const CONFIG_PATH = process.env.AICOS_REPOS_CONFIG || join(HOME, ".config", "aicos", "repos-config.json");

export interface RepoConfig { root: string; projectsRoot: string }

// Carpeta base donde los proyectos NUEVOS (greenfield) se generan como
// subcarpetas: <projectsRoot>/<slug>. El bridge (registry.ts) lee el mismo
// archivo de config para resolver el cwd de un proyecto sin mapping explícito.
const DEFAULT_PROJECTS_ROOT = join(HOME, "Projects");
export interface RepoInfo {
  name: string;
  path: string;
  git: boolean;
  branch?: string;
  kind: string;       // node / python / go / rust / docker / repo / folder…
  description?: string;
}

export function getConfig(): RepoConfig {
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { root: c.root || HOME, projectsRoot: c.projectsRoot || DEFAULT_PROJECTS_ROOT };
  } catch { return { root: HOME, projectsRoot: DEFAULT_PROJECTS_ROOT }; }
}

function writeConfig(cfg: RepoConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function setRoot(root: string): RepoConfig {
  const cur = getConfig();
  const cfg = { root: resolve(root), projectsRoot: cur.projectsRoot };
  writeConfig(cfg);
  return cfg;
}

export function setProjectsRoot(projectsRoot: string): RepoConfig {
  const cur = getConfig();
  const p = resolve(projectsRoot);
  const cfg = { root: cur.root, projectsRoot: p };
  // creamos la carpeta de proyectos así existe antes del primer proyecto nuevo
  try { mkdirSync(p, { recursive: true }); } catch { /* */ }
  writeConfig(cfg);
  return cfg;
}

/** Nombre de carpeta seguro a partir de la URL del repo (último segmento sin .git). */
function leafFromUrl(url: string): string {
  let s = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  s = s.split(/[/:]/).pop() || "";
  return s;
}

/** Quita credenciales embebidas de una URL https (user:token@host → host). */
function stripCreds(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]+@/i, "$1");
}

export interface CloneResult { ok: true; path: string; name: string }

/**
 * Clona un repo git DENTRO de la carpeta de proyectos como subcarpeta:
 * <projectsRoot>/<name>. Corre como el usuario del proceso (el dashboard ya
 * corre como uid 1000 = el mismo de los agentes), así el clon queda con el
 * dueño correcto. Si la URL trae token (user:token@), lo limpiamos del
 * `origin` tras clonar para no dejar el secreto en .git/config.
 */
export function cloneRepo(url: string, name?: string): CloneResult {
  const u = (url || "").trim();
  if (!/^(https?:\/\/|git@)/i.test(u)) {
    throw new Error("URL inválida — usá https://… o git@…");
  }
  const { projectsRoot } = getConfig();
  const rawLeaf = (name && name.trim()) || leafFromUrl(u);
  const leaf = rawLeaf.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!leaf) throw new Error("no pude derivar un nombre de carpeta válido");
  const target = join(projectsRoot, leaf);
  // anti path-traversal: el target tiene que colgar directo de projectsRoot
  if (dirname(resolve(target)) !== resolve(projectsRoot) || basename(target) !== leaf) {
    throw new Error("ruta destino inválida");
  }
  if (existsSync(target)) throw new Error(`ya existe una carpeta «${leaf}» en proyectos`);
  mkdirSync(projectsRoot, { recursive: true });

  const r = spawnSync("git", ["clone", u, target], {
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0) {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* */ }
    const msg = (r.stderr || r.error?.message || "git clone falló").trim().split("\n").slice(-3).join(" ");
    throw new Error(msg);
  }
  // si la URL traía credenciales, dejamos el origin limpio (sin token)
  if (u !== stripCreds(u)) {
    spawnSync("git", ["-C", target, "remote", "set-url", "origin", stripCreds(u)], { encoding: "utf8" });
  }
  return { ok: true, path: target, name: leaf };
}

function detectKind(p: string): { kind: string; description?: string } {
  const has = (f: string) => existsSync(join(p, f));
  let description: string | undefined;
  try {
    if (has("package.json")) {
      const pkg = JSON.parse(readFileSync(join(p, "package.json"), "utf8"));
      description = pkg.description || undefined;
      return { kind: pkg.dependencies?.next ? "next" : "node", description };
    }
  } catch { /* */ }
  // README primera línea como descripción
  for (const rd of ["README.md", "readme.md", "README"]) {
    if (has(rd)) {
      try {
        const first = readFileSync(join(p, rd), "utf8").split("\n").find((l) => l.trim() && !l.startsWith("#"));
        if (first) description = first.trim().slice(0, 140);
      } catch { /* */ }
      break;
    }
  }
  if (has("requirements.txt") || has("pyproject.toml")) return { kind: "python", description };
  if (has("go.mod")) return { kind: "go", description };
  if (has("Cargo.toml")) return { kind: "rust", description };
  if (has("composer.json")) return { kind: "php", description };
  if (has("Dockerfile") || has("docker-compose.yml")) return { kind: "docker", description };
  return { kind: existsSync(join(p, ".git")) ? "repo" : "folder", description };
}

function gitBranch(p: string): string | undefined {
  try {
    const head = readFileSync(join(p, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref:") ? head.split("/").pop() : head.slice(0, 8);
  } catch { return undefined; }
}

export function scanRepos(root: string): RepoInfo[] {
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return []; }
  const out: RepoInfo[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const p = join(root, name);
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const git = existsSync(join(p, ".git"));
    const { kind, description } = detectKind(p);
    // mostramos solo repos o apps (no carpetas sueltas vacías)
    if (!git && kind === "folder") continue;
    out.push({ name, path: p, git, branch: git ? gitBranch(p) : undefined, kind, description });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** ¿`p` está dentro de la raíz configurada? (anti path-traversal) */
export function isUnderRoot(p: string): boolean {
  const root = resolve(getConfig().root);
  const rp = resolve(p);
  return rp === root || rp.startsWith(root + "/");
}

export function listDir(p: string): { name: string; dir: boolean }[] {
  try {
    return readdirSync(p)
      .filter((n) => !n.startsWith(".git"))
      .map((n) => {
        let dir = false;
        try { dir = statSync(join(p, n)).isDirectory(); } catch { /* */ }
        return { name: n, dir };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .slice(0, 200);
  } catch { return []; }
}

export function readReadme(p: string): string | null {
  for (const rd of ["README.md", "readme.md", "README"]) {
    try { return readFileSync(join(p, rd), "utf8").slice(0, 6000); } catch { /* */ }
  }
  return null;
}
