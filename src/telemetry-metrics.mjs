/**
 * Lightweight in-process metrics aggregation for Memact Memory.
 *
 * Provides counters, histograms, and gauges — all stored in-memory with
 * no external dependencies. Designed for integration with the telemetry
 * collector and the stats server /metrics endpoint.
 *
 * @module telemetry-metrics
 */

/**
 * Creates a monotonic counter that can only be incremented.
 * @param {string} name - Counter name
 * @param {string} [description=""] - Human-readable description
 * @returns {Object} Counter instance
 */
export function createCounter(name, description = "") {
  let value = 0;
  const labels = new Map();

  return Object.freeze({
    name,
    description,
    kind: "counter",

    /**
     * Increments the counter by the given amount.
     * @param {number} [amount=1]
     * @param {Object} [labelSet={}] - Optional dimension labels
     */
    inc(amount = 1, labelSet = {}) {
      const delta = Math.max(0, Number(amount) || 0);
      value += delta;
      const key = labelKey(labelSet);
      if (key) {
        labels.set(key, (labels.get(key) || 0) + delta);
      }
    },

    /** @returns {number} Current counter value */
    get value() {
      return value;
    },

    /**
     * Returns value for a specific label set.
     * @param {Object} labelSet
     * @returns {number}
     */
    valueOf(labelSet) {
      return labels.get(labelKey(labelSet)) || 0;
    },

    /** Resets the counter to zero. */
    reset() {
      value = 0;
      labels.clear();
    },

    /** @returns {Object} Serializable snapshot */
    snapshot() {
      return {
        name,
        kind: "counter",
        value,
        labels: Object.fromEntries(labels),
      };
    },
  });
}

/**
 * Creates a gauge that can be set to arbitrary values.
 * @param {string} name - Gauge name
 * @param {string} [description=""] - Human-readable description
 * @returns {Object} Gauge instance
 */
export function createGauge(name, description = "") {
  let value = 0;

  return Object.freeze({
    name,
    description,
    kind: "gauge",

    /**
     * Sets the gauge to an absolute value.
     * @param {number} newValue
     */
    set(newValue) {
      value = Number(newValue) || 0;
    },

    /** Increments the gauge by amount. */
    inc(amount = 1) {
      value += Number(amount) || 0;
    },

    /** Decrements the gauge by amount. */
    dec(amount = 1) {
      value -= Number(amount) || 0;
    },

    /** @returns {number} Current gauge value */
    get value() {
      return value;
    },

    /** Resets the gauge to zero. */
    reset() {
      value = 0;
    },

    /** @returns {Object} Serializable snapshot */
    snapshot() {
      return { name, kind: "gauge", value };
    },
  });
}

/**
 * Creates a histogram for recording value distributions.
 * Tracks count, sum, min, max, and configurable percentiles.
 * @param {string} name - Histogram name
 * @param {Object} [options={}]
 * @param {string} [options.description=""]
 * @param {number[]} [options.percentiles=[0.5, 0.9, 0.95, 0.99]] - Percentiles to compute
 * @param {number} [options.maxSamples=1000] - Max samples to retain for percentile calculation
 * @returns {Object} Histogram instance
 */
export function createHistogram(name, options = {}) {
  const description = options.description || "";
  const percentiles = options.percentiles || [0.5, 0.9, 0.95, 0.99];
  const maxSamples = options.maxSamples || 1000;

  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let samples = [];

  return Object.freeze({
    name,
    description,
    kind: "histogram",

    /**
     * Records a single observation.
     * @param {number} value
     */
    observe(value) {
      const v = Number(value) || 0;
      count += 1;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      samples.push(v);
      if (samples.length > maxSamples) {
        samples = samples.slice(-maxSamples);
      }
    },

    /** @returns {number} Total observation count */
    get count() {
      return count;
    },

    /** @returns {number} Sum of all observations */
    get sum() {
      return sum;
    },

    /** @returns {number} Minimum observed value */
    get min() {
      return count > 0 ? min : 0;
    },

    /** @returns {number} Maximum observed value */
    get max() {
      return count > 0 ? max : 0;
    },

    /** @returns {number} Average of all observations */
    get avg() {
      return count > 0 ? Number((sum / count).toFixed(4)) : 0;
    },

    /**
     * Computes a specific percentile from the retained samples.
     * @param {number} p - Percentile as a fraction (e.g. 0.95)
     * @returns {number}
     */
    percentile(p) {
      if (samples.length === 0) return 0;
      const sorted = [...samples].sort((a, b) => a - b);
      const index = Math.ceil(p * sorted.length) - 1;
      return sorted[Math.max(0, index)];
    },

    /** Resets all histogram state. */
    reset() {
      count = 0;
      sum = 0;
      min = Infinity;
      max = -Infinity;
      samples = [];
    },

    /** @returns {Object} Serializable snapshot */
    snapshot() {
      const pctResults = {};
      for (const p of percentiles) {
        const label = `p${Math.round(p * 100)}`;
        pctResults[label] = samples.length > 0 ? this.percentile(p) : 0;
      }
      return {
        name,
        kind: "histogram",
        count,
        sum: Number(sum.toFixed(4)),
        min: count > 0 ? min : 0,
        max: count > 0 ? max : 0,
        avg: this.avg,
        percentiles: pctResults,
      };
    },
  });
}

/**
 * Creates a complete metrics registry pre-populated with the standard
 * Memact Memory metric instruments.
 *
 * @returns {Object} Registry with named counters, gauges, histograms, and snapshot/reset methods
 *
 * @example
 * const metrics = createMetricsRegistry();
 * metrics.operationTotal.inc(1, { type: "memory.created" });
 * metrics.operationDuration.observe(12.5);
 * const snap = metrics.snapshot();
 */
export function createMetricsRegistry() {
  const operationTotal = createCounter(
    "operation_total",
    "Total operations by type"
  );
  const errorTotal = createCounter(
    "error_total",
    "Total errors by operation type"
  );
  const memoryCount = createCounter(
    "memory_count",
    "Memories processed by type and state"
  );

  const operationDuration = createHistogram("operation_duration_ms", {
    description: "Operation duration in milliseconds",
  });
  const retrievalScoreDistribution = createHistogram(
    "retrieval_score_distribution",
    {
      description: "Distribution of retrieval scores",
    }
  );
  const memoryStrengthDistribution = createHistogram(
    "memory_strength_distribution",
    {
      description: "Distribution of memory strength values",
    }
  );

  const activeMemoryCount = createGauge(
    "active_memory_count",
    "Current count of active memories"
  );
  const relationCount = createGauge(
    "relation_count",
    "Current count of memory relations"
  );
  const cacheSize = createGauge(
    "cache_size",
    "Current query cache size"
  );
  const databaseSizeBytes = createGauge(
    "database_size_bytes",
    "Serialized database size in bytes"
  );

  const instruments = {
    operationTotal,
    errorTotal,
    memoryCount,
    operationDuration,
    retrievalScoreDistribution,
    memoryStrengthDistribution,
    activeMemoryCount,
    relationCount,
    cacheSize,
    databaseSizeBytes,
  };

  return Object.freeze({
    ...instruments,

    /**
     * Returns a serializable snapshot of all instruments.
     * @returns {Object}
     */
    snapshot() {
      const result = {};
      for (const [key, instrument] of Object.entries(instruments)) {
        result[key] = instrument.snapshot();
      }
      return result;
    },

    /**
     * Resets all instruments. Primarily for test isolation.
     */
    reset() {
      for (const instrument of Object.values(instruments)) {
        instrument.reset();
      }
    },
  });
}

/**
 * Produces a stable string key from a label set object for Map lookups.
 * @param {Object} labelSet
 * @returns {string}
 */
function labelKey(labelSet = {}) {
  const entries = Object.entries(labelSet).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return entries.length > 0
    ? entries.map(([k, v]) => `${k}=${v}`).join(",")
    : "";
}
