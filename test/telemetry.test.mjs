import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelemetryCollector,
  TELEMETRY_EVENTS,
} from "../src/telemetry.mjs";


// Collector — creation and event emission


test("createTelemetryCollector creates a functional collector", () => {
  const collector = createTelemetryCollector();
  assert.strictEqual(collector.enabled, true);
  assert.deepStrictEqual(collector.getBuffer(), []);
  assert.deepStrictEqual(collector.getMetrics(), {});
});

test("collector.emit creates a well-shaped event", () => {
  const collector = createTelemetryCollector();
  const event = collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {
    memory_id: "m_01",
  });

  assert.strictEqual(event.type, "memory.created");
  assert.strictEqual(event.operation, "memory.created");
  assert.strictEqual(event.payload.memory_id, "m_01");
  assert.ok(event.timestamp);
  assert.match(event.trace_id, /^[0-9a-f]{32}$/);
});

test("collector buffers emitted events", () => {
  const collector = createTelemetryCollector();
  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, { memory_id: "m_01" });
  collector.emit(TELEMETRY_EVENTS.MEMORY_UPDATED, { memory_id: "m_02" });

  const buffer = collector.getBuffer();
  assert.strictEqual(buffer.length, 2);
  assert.strictEqual(buffer[0].type, "memory.created");
  assert.strictEqual(buffer[1].type, "memory.updated");
});


// Collector — subscribers



test("collector.on registers typed subscribers that receive events", () => {
  const collector = createTelemetryCollector();
  const received = [];
  collector.on(TELEMETRY_EVENTS.MEMORY_CREATED, (e) => received.push(e));

  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  collector.emit(TELEMETRY_EVENTS.MEMORY_UPDATED, {});

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, "memory.created");
});

test("collector.on with wildcard receives all events", () => {
  const collector = createTelemetryCollector();
  const received = [];
  collector.on("*", (e) => received.push(e));

  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  collector.emit(TELEMETRY_EVENTS.MEMORY_DELETED, {});
  collector.emit(TELEMETRY_EVENTS.RAG_BUILT, {});

  assert.strictEqual(received.length, 3);
});

test("collector.off removes a subscriber", () => {
  const collector = createTelemetryCollector();
  const received = [];
  const handler = (e) => received.push(e);

  collector.on(TELEMETRY_EVENTS.MEMORY_CREATED, handler);
  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  assert.strictEqual(received.length, 1);

  collector.off(TELEMETRY_EVENTS.MEMORY_CREATED, handler);
  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  assert.strictEqual(received.length, 1);
});

test("subscriber errors do not break event emission", () => {
  const collector = createTelemetryCollector();
  const received = [];

  collector.on(TELEMETRY_EVENTS.MEMORY_CREATED, () => {
    throw new Error("subscriber crash");
  });
  collector.on(TELEMETRY_EVENTS.MEMORY_CREATED, (e) => received.push(e));

  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  assert.strictEqual(received.length, 1);
});

// Collector — span timing

test("collector.startSpan measures duration on end", async () => {
  const collector = createTelemetryCollector();
  const span = collector.startSpan(TELEMETRY_EVENTS.QUERY_EXECUTED);

  // Simulate some work
  await new Promise((resolve) => setTimeout(resolve, 10));

  const event = span.end({ result_count: 5 });
  assert.strictEqual(event.type, "query.executed");
  assert.ok(event.duration_ms >= 0);
  assert.strictEqual(event.payload.result_count, 5);
});

test("span.end can only be called once", async () => {
  const collector = createTelemetryCollector();
  const span = collector.startSpan(TELEMETRY_EVENTS.MEMORY_CREATED);

  const firstResult = span.end({});
  const secondResult = span.end({});

  assert.ok(firstResult !== null);
  assert.strictEqual(secondResult, null);
});

test("span shares trace_id from context", () => {
  const collector = createTelemetryCollector();
  const validTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const span = collector.startSpan(TELEMETRY_EVENTS.MEMORY_CREATED, {
    trace_id: validTraceId,
  });
  const event = span.end({});
  assert.strictEqual(event.trace_id, validTraceId);
});

// Collector — flush and sinks

test("collector.flush drains buffer and invokes sinks", () => {
  const collector = createTelemetryCollector();
  const sinkBatches = [];
  collector.addSink((events) => sinkBatches.push(events));

  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  collector.emit(TELEMETRY_EVENTS.MEMORY_UPDATED, {});

  const flushed = collector.flush();
  assert.strictEqual(flushed.length, 2);
  assert.strictEqual(sinkBatches.length, 1);
  assert.strictEqual(sinkBatches[0].length, 2);
  assert.deepStrictEqual(collector.getBuffer(), []);
});

test("sink errors do not propagate", () => {
  const collector = createTelemetryCollector();
  collector.addSink(() => {
    throw new Error("sink crash");
  });

  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  assert.doesNotThrow(() => collector.flush());
});

// Collector — metrics

test("collector.getMetrics returns operation counts and durations", () => {
  const collector = createTelemetryCollector();
  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  collector.emit(TELEMETRY_EVENTS.MEMORY_DELETED, {});

  const metrics = collector.getMetrics();
  assert.strictEqual(metrics["memory.created"].count, 2);
  assert.strictEqual(metrics["memory.deleted"].count, 1);
});

test("collector.getMetrics tracks error count", () => {
  const collector = createTelemetryCollector();
  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, { error: "test error" });

  const metrics = collector.getMetrics();
  assert.strictEqual(metrics["memory.created"].errors, 1);
});

// Collector — reset

test("collector.reset clears all state", () => {
  const collector = createTelemetryCollector();
  collector.on("*", () => {});
  collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});

  collector.reset();
  assert.deepStrictEqual(collector.getBuffer(), []);
  assert.deepStrictEqual(collector.getMetrics(), {});
});

// Collector — buffer limit

test("collector respects buffer size limit", () => {
  const collector = createTelemetryCollector({ bufferSize: 3 });

  for (let i = 0; i < 10; i++) {
    collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, { i });
  }

  assert.strictEqual(collector.getBuffer().length, 3);
});

// Disabled collector

test("disabled collector returns null from emit", () => {
  const collector = createTelemetryCollector({ enabled: false });
  const event = collector.emit(TELEMETRY_EVENTS.MEMORY_CREATED, {});
  assert.strictEqual(event, null);
  assert.strictEqual(collector.getBuffer().length, 0);
});
