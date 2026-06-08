import type Redis from "ioredis";

export interface AuditEntry {
  ts: string;
  tool: string;
  action: string;
  actor: { id: string; registryId?: string };
  decision: "allow" | "require_approval" | "deny";
  reason?: string;
  params?: Record<string, unknown>;
  result?: { ok: boolean; status?: number; durationMs?: number };
}

const AUDIT_TTL_DAYS = 30;

export class RedisAudit {
  constructor(private readonly redis: Redis) {}

  async record(entry: AuditEntry): Promise<void> {
    const date = entry.ts.slice(0, 10);
    const key = `tool-gateway:audit:${date}`;
    try {
      await this.redis.rpush(key, JSON.stringify(entry));
      await this.redis.expire(key, AUDIT_TTL_DAYS * 24 * 3600, "NX");
      // Per-actor counter for quick stats
      const counterKey = `tool-gateway:actor:${entry.actor.id}:${entry.tool}`;
      await this.redis.hincrby(counterKey, `total`, 1);
      await this.redis.hincrby(counterKey, `decision:${entry.decision}`, 1);
      await this.redis.expire(counterKey, AUDIT_TTL_DAYS * 24 * 3600, "NX");
    } catch (e) {
      process.stderr.write(`[audit] write fail: ${(e as Error).message}\n`);
    }
  }

  async recent(limit: number = 50): Promise<AuditEntry[]> {
    try {
      const date = new Date().toISOString().slice(0, 10);
      const raw = await this.redis.lrange(`tool-gateway:audit:${date}`, -limit, -1);
      return raw
        .map((s) => {
          try {
            return JSON.parse(s) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((x): x is AuditEntry => x !== null)
        .reverse();
    } catch {
      return [];
    }
  }
}
