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
 * Create an HTTP server that serves memory statistics on GET requests.
 * Access is restricted to loopback (localhost) connections only.
 *
 * @param {{ loadMemories: () => Promise<object[]>, now?: () => number }} options
 * @returns {import("node:http").Server}
 */
   export function createStatsServer({ loadMemories, now = Date.now, logger = console.log } = {}) {
  if (typeof loadMemories !== "function") {
    throw new TypeError("createStatsServer requires loadMemories to be a function");
  }

  const server = createServer(async (req, res) => {
    const remoteAddr = req.socket.remoteAddress;

    if (!isLoopbackAddress(remoteAddr)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

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
