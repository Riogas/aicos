/**
 * Server-side fetcher with short timeout + graceful degradation.
 * Use ONLY in Server Components (no client-side use of internal URLs).
 */
const TIMEOUT_MS = 4000;

export async function safeFetch<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export const URLS = {
  quotaStatus: () => `${process.env.QUOTA_SERVICE_URL}/status`,
  policyHealth: () => `${process.env.POLICY_SERVICE_URL}/health`,
  policyRules: () => `${process.env.POLICY_SERVICE_URL}/rules`,
  learningSummary: () => `${process.env.LEARNING_SERVICE_URL}/summary`,
  learningRecent: () => `${process.env.LEARNING_SERVICE_URL}/recent`,
  bridgeHealth: () => `${process.env.BRIDGE_SERVICE_URL}/health`,
};
