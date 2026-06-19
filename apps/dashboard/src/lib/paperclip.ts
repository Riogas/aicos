/** Helper mínimo para hablar con la API de Paperclip con el board token. */
export const PAPERCLIP = process.env.PAPERCLIP_API_URL || "http://localhost:3100";
export const BRIDGE = process.env.BRIDGE_SERVICE_URL || "http://localhost:7100";
export const COMPANY = process.env.AICOS_COMPANY_ID || "";
export const PC_TOKEN = process.env.PAPERCLIP_BOARD_TOKEN || process.env.PAPERCLIP_API_KEY || "";

export async function pc(method: string, path: string, body?: unknown): Promise<{ code: number; data: any }> {
  const res = await fetch(PAPERCLIP + path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${PC_TOKEN}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store", // Next cachea fetch() por defecto → sin esto, los GET quedan viejos
    signal: AbortSignal.timeout(12000),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { code: res.status, data };
}

export async function bridge(method: string, path: string, body?: unknown): Promise<{ code: number; data: any }> {
  const res = await fetch(BRIDGE + path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { code: res.status, data };
}

/** Lista de issues por status (la API solo soporta un status por query). */
export async function issuesByStatus(status: string): Promise<any[]> {
  const { code, data } = await pc("GET", `/api/companies/${COMPANY}/issues?status=${status}`);
  if (code !== 200) return [];
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function listAgents(): Promise<any[]> {
  const { code, data } = await pc("GET", `/api/companies/${COMPANY}/agents`);
  if (code !== 200) return [];
  return Array.isArray(data) ? data : (data.items ?? data.agents ?? []);
}
