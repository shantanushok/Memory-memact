import { randomBytes } from "node:crypto";

/**
 * Core telemetry event bus for Memact Memory.
 *
 * Provides a lightweight pub/sub collector with span timing, typed events,
 * wildcard subscribers, buffered flush, and pluggable sink support.
 * No external dependencies — designed for zero-overhead opt-in instrumentation.
 *
 * @module telemetry
 */

/**
 * Canonical telemetry event types emitted by instrumented engine operations.
 */
export const TELEMETRY_EVENTS = Object.freeze({
  MEMORY_CREATED: "memory.created",
  MEMORY_UPDATED: "memory.updated",
  MEMORY_DELETED: "memory.deleted",
  MEMORY_RETRIEVED: "memory.retrieved",
  MEMORY_FORGOTTEN: "memory.forgotten",
  MEMORY_SUPERSEDED: "memory.superseded",
  MEMORY_REINFORCED: "memory.reinforced",
  MEMORY_WEAKENED: "memory.weakened",
  SCHEMA_ASSIMILATED: "schema.assimilated",
  SCHEMA_ACCOMMODATED: "schema.accommodated",
  SCHEMA_REMEMBERED: "schema.remembered",
  INTENT_REMEMBERED: "intent.remembered",
  RELATION_ADDED: "relation.added",
  STORE_BUILT: "store.built",
  STORE_REINDEXED: "store.reindexed",
  QUERY_EXECUTED: "query.executed",
  RAG_BUILT: "rag.built",
  PACKET_REMEMBERED: "packet.remembered",
  CORRECTION_CREATED: "correction.created",
  DATABASE_SIZE: "database.size",
});

const WILDCARD = "*";

/**
 * Generates a W3C Trace Context compatible trace ID (32-character hex string).
 * @returns {string}
 */
function generateTraceId() {
  return randomBytes(16).toString("hex");
}

/**
 * Creates a new TelemetryEvent object.
 * @param {string} type - One of TELEMETRY_EVENTS
 * @param {Object} [payload={}] - Event-specific data
 * @param {Object} [context={}] - Additional context (trace_id, duration_ms)
 * @returns {Object} A frozen telemetry event
 */
function createEvent(type, payload = {}, context = {}) {
  return Object.freeze({
    type,
    timestamp: new Date().toISOString(),
    trace_id: context.trace_id || generateTraceId(),
    duration_ms: context.duration_ms ?? null,
    memory_id: payload.memory_id || null,
    operation: type,
    payload,
  });
}

/**
 * Creates a telemetry collector instance with pub/sub event management,
 * span timing, buffered flush, and metrics aggregation.
 *
 * @param {Object} [options={}]
 * @param {number} [options.bufferSize=200] - Max events to buffer before auto-flush
 * @param {boolean} [options.enabled=true] - Master enable/disable toggle
 * @returns {Object} Collector instance
 *
 * @example
 * const collector = createTelemetryCollector();
 * collector.on("memory.created", (event) => console.log(event));
 * collector.on("*", (event) => auditLog(event));
 *
 * const span = collector.startSpan("memory.created");
 * // ... do work ...
 * span.end({ memory_id: "m_01" });
 */
export function createTelemetryCollector(options = {}) {
  const bufferSize = Number(options.bufferSize ?? 200);
  const enabled = options.enabled !== false;

  /** @type {Map<string, Set<Function>>} */
  const subscribers = new Map();

  /** @type {Array<Object>} */
  let eventBuffer = [];

  /** @type {Object<string, { count: number, totalDuration: number, errors: number }>} */
  const operationMetrics = {};

  /** @type {Array<Function>} */
  const sinks = [];

  /**
   * Registers a subscriber for a specific event type or wildcard.
   * @param {string} eventType - Event type or "*" for all events
   * @param {Function} handler - Callback receiving the TelemetryEvent
   */
  function on(eventType, handler) {
    if (typeof handler !== "function") return;
    if (!subscribers.has(eventType)) {
      subscribers.set(eventType, new Set());
    }
    subscribers.get(eventType).add(handler);
  }

  /**
   * Removes a previously registered subscriber.
   * @param {string} eventType
   * @param {Function} handler
   */
  function off(eventType, handler) {
    const handlers = subscribers.get(eventType);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) subscribers.delete(eventType);
    }
  }

  /**
   * Emits a telemetry event to all matching subscribers and buffers it.
   * @param {string} type - Event type
   * @param {Object} [payload={}] - Event data
   * @param {Object} [context={}] - Trace context
   * @returns {Object} The emitted event
   */
  function emit(type, payload = {}, context = {}) {
    if (!enabled) return null;

    const event = createEvent(type, payload, context);

    // Update operation metrics
    if (!operationMetrics[type]) {
      operationMetrics[type] = { count: 0, totalDuration: 0, errors: 0 };
    }
    operationMetrics[type].count += 1;
    if (event.duration_ms != null) {
      operationMetrics[type].totalDuration += event.duration_ms;
    }
    if (payload.error) {
      operationMetrics[type].errors += 1;
    }

    // Buffer the event
    eventBuffer.push(event);
    if (eventBuffer.length > bufferSize) {
      eventBuffer = eventBuffer.slice(-bufferSize);
    }

    // Notify typed subscribers
    const typedHandlers = subscribers.get(type);
    if (typedHandlers) {
      for (const handler of typedHandlers) {
        try {
          handler(event);
        } catch {
          // Subscriber errors must not break the instrumented operation
        }
      }
    }

    // Notify wildcard subscribers
    const wildcardHandlers = subscribers.get(WILDCARD);
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch {
          // Subscriber errors must not break the instrumented operation
        }
      }
    }

    return event;
  }

  /**
   * Starts a timed span for an operation. Call `span.end(payload)` to
   * emit the event with duration measurement.
   * @param {string} eventType - The event type to emit on end
   * @param {Object} [context={}] - Shared trace context
   * @returns {{ end: (payload?: Object) => Object }}
   */
  function startSpan(eventType, context = {}) {
    const traceId = context.trace_id || generateTraceId();
    const startTime = performance.now();
    let ended = false;

    return {
      /**
       * Ends the span and emits the telemetry event.
       * @param {Object} [payload={}] - Event-specific data
       * @returns {Object} The emitted event
       */
      end(payload = {}) {
        if (ended) return null;
        ended = true;
        const durationMs = Number((performance.now() - startTime).toFixed(2));
        return emit(eventType, payload, {
          trace_id: traceId,
          duration_ms: durationMs,
        });
      },
    };
  }

  /**
   * Drains the event buffer to all registered sinks.
   * @returns {Array<Object>} The flushed events
   */
  function flush() {
    const events = [...eventBuffer];
    eventBuffer = [];
    for (const sink of sinks) {
      try {
        sink(events);
      } catch {
        // Sink errors must not propagate
      }
    }
    return events;
  }

  /**
   * Registers a sink function that receives batches of events on flush.
   * @param {Function} sinkFn - Receives an array of events
   */
  function addSink(sinkFn) {
    if (typeof sinkFn === "function") {
      sinks.push(sinkFn);
    }
  }

  /**
   * Returns aggregated metrics for all recorded operations.
   * @returns {Object} Metrics keyed by event type
   */
  function getMetrics() {
    const result = {};
    for (const [type, data] of Object.entries(operationMetrics)) {
      result[type] = {
        count: data.count,
        total_duration_ms: Number(data.totalDuration.toFixed(2)),
        avg_duration_ms:
          data.count > 0
            ? Number((data.totalDuration / data.count).toFixed(2))
            : 0,
        errors: data.errors,
      };
    }
    return result;
  }

  /**
   * Returns the current event buffer contents without draining.
   * @returns {Array<Object>}
   */
  function getBuffer() {
    return [...eventBuffer];
  }

  /**
   * Resets all internal state — metrics, buffer, subscribers, sinks.
   * Primarily for test isolation.
   */
  function reset() {
    eventBuffer = [];
    subscribers.clear();
    sinks.length = 0;
    for (const key of Object.keys(operationMetrics)) {
      delete operationMetrics[key];
    }
  }

  return Object.freeze({
    on,
    off,
    emit,
    startSpan,
    flush,
    addSink,
    getMetrics,
    getBuffer,
    reset,
    get enabled() {
      return enabled;
    },
  });
}
