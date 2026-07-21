import { createServer } from "node:http";
import { logDatabaseSize } from "./telemetry.mjs";
import { computeMemoryStats } from "./memory-stats.mjs";

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Return true when addr is a loopback address.
 * @param {string} addr
 * @returns {boolean}
 */
export function isLoopbackAddress(addr) {
  return LOOPBACK_ADDRS.has(addr);
}

/**
 * Create an HTTP server that serves memory statistics, telemetry metrics,
 * and a health check endpoint. Access is restricted to loopback connections only.
 *
 * Endpoints:
 *   GET /         — existing memory stats (unchanged)
 *   GET /metrics  — telemetry metrics snapshot (new)
 *   GET /health   — liveness probe (new)
 *
 * @param {{ loadMemories: () => Promise<object[]>, now?: () => number, collector?: Object }} options
 * @returns {import("node:http").Server}
 */
export function createStatsServer({
  loadMemories,
  now = Date.now,
  collector = null,
  logger = console.log,
} = {}) {
  if (typeof loadMemories !== "function") {
    throw new TypeError("createStatsServer requires loadMemories to be a function");
  }

  const serverStartTime = Date.now();

  const server = createServer(async (req, res) => {
    const remoteAddr = req.socket.remoteAddress;

    if (!isLoopbackAddress(remoteAddr)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;

    // Health endpoint — lightweight liveness probe
    if (pathname === "/health") {
      try {
        const memories = await loadMemories();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          uptime_ms: now() - serverStartTime,
          memory_count: Array.isArray(memories) ? memories.length : 0,
        }));
      } catch (err) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    // Metrics endpoint — telemetry collector snapshot
    if (pathname === "/metrics") {
      if (!collector) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          message: "No telemetry collector configured",
          metrics: {},
        }));
        return;
      }
      try {
        const metrics = typeof collector.getMetrics === "function"
          ? collector.getMetrics()
          : {};
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(metrics));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error", message: err.message }));
      }
      return;
    }

    // Default endpoint — existing memory stats behavior
    try {
      const memories = await loadMemories();
      logDatabaseSize({ memories }, logger);
      const stats = computeMemoryStats(memories, { now: now() });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error", message: err.message }));
    }
  });

  return server;
}
