// Instrumentation for database size and query performance metrics.
// Pure/side-effect-light: logging is injectable so tests don't need to
// capture real console output.

/**
 * Computes the on-disk size of a memory store, in bytes.
 * @param {Object} memoryStore
 * @returns {number}
 */
export function computeDatabaseSizeBytes(memoryStore = {}) {
  return Buffer.byteLength(JSON.stringify(memoryStore), "utf8");
}

/**
 * Logs the current database size and memory count.
 * @param {Object} memoryStore
 * @param {(entry: object) => void} [logger] - Defaults to console.log
 * @returns {{ event: string, bytes: number, memoryCount: number, timestamp: string }}
 */
export function logDatabaseSize(memoryStore = {}, logger = console.log) {
  const entry = {
    event: "database_size",
    bytes: computeDatabaseSizeBytes(memoryStore),
    memoryCount: Array.isArray(memoryStore.memories) ? memoryStore.memories.length : 0,
    timestamp: new Date().toISOString(),
  };
  logger(JSON.stringify(entry));
  return entry;
}

/**
 * Wraps a query function so every call logs its duration and result count.
 * @param {Function} queryFn - e.g. retrieveMemories
 * @param {(entry: object) => void} [logger] - Defaults to console.log
 * @returns {Function} A wrapped version of queryFn with identical behavior
 */
export function instrumentQuery(queryFn, logger = console.log) {
  return function instrumented(...args) {
    const startedAt = Date.now();
    const result = queryFn(...args);
    const durationMs = Date.now() - startedAt;
    const resultCount = Array.isArray(result) ? result.length : (Array.isArray(result?.memories) ? result.memories.length : undefined);

    logger(JSON.stringify({
      event: "query_metrics",
      durationMs,
      resultCount,
      timestamp: new Date().toISOString(),
    }));

    return result;
  };
}