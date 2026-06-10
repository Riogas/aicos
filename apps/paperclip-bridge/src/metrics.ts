/**
 * Prometheus instrumentation for the bridge.
 *
 * Default metric set:
 *   - aicos_http_requests_total{method,route,status}
 *   - aicos_http_request_duration_ms{method,route}  (histogram)
 *   - aicos_inflight_runs                          (gauge)
 *   - aicos_fallback_attempts_total{provider,outcome}  (counter)
 *   - aicos_orchestrate_subtasks_total              (counter)
 *   - aicos_policy_decisions_total{decision}        (counter)
 *
 * Plus the default Node.js metrics (event loop lag, GC, heap usage) via
 * collectDefaultMetrics() so we get a sensible operational baseline.
 */

import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import type { FastifyInstance } from "fastify";
import type { InFlightTracker } from "./in-flight-tracker.js";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequests = new Counter({
  name: "aicos_http_requests_total",
  help: "Total HTTP requests handled by the bridge",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegistry],
});

export const httpDuration = new Histogram({
  name: "aicos_http_request_duration_ms",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method", "route"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  registers: [metricsRegistry],
});

export const inflightRuns = new Gauge({
  name: "aicos_inflight_runs",
  help: "Number of in-flight runs currently tracked",
  registers: [metricsRegistry],
});

export const fallbackAttempts = new Counter({
  name: "aicos_fallback_attempts_total",
  help: "Per-provider retry-with-fallback attempts",
  labelNames: ["provider", "outcome"],
  registers: [metricsRegistry],
});

export const orchestrateSubtasks = new Counter({
  name: "aicos_orchestrate_subtasks_total",
  help: "Total subtasks created by the orchestrator",
  registers: [metricsRegistry],
});

export const policyDecisions = new Counter({
  name: "aicos_policy_decisions_total",
  help: "Decisions returned by the policy engine",
  labelNames: ["decision"],
  registers: [metricsRegistry],
});

export function attachMetrics(app: FastifyInstance, tracker: InFlightTracker): void {
  // Tracker gauge sync: re-read on every tracker event so the gauge is
  // never stale.
  const updateInflight = () => inflightRuns.set(tracker.list().length);
  tracker.on("event", updateInflight);
  updateInflight();

  // Request count + duration via Fastify hooks. Skip the metrics route itself
  // so we don't infinite-loop counters.
  app.addHook("onResponse", async (req, reply) => {
    if (req.routeOptions?.url === "/metrics") return;
    const route = req.routeOptions?.url ?? "unknown";
    const status = String(reply.statusCode);
    httpRequests.inc({ method: req.method, route, status });
    httpDuration.observe(
      { method: req.method, route },
      reply.elapsedTime ?? 0,
    );
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
