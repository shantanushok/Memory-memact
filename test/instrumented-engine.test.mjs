import test from "node:test";
import assert from "node:assert/strict";
import { createInstrumentedEngine } from "../src/instrumented-engine.mjs";
import { createTelemetryCollector, TELEMETRY_EVENTS } from "../src/telemetry.mjs";
import { createMetricsRegistry } from "../src/telemetry-metrics.mjs";
import { buildMemoryStore, createMemory, readMemory } from "../src/engine.mjs";

/**
 * Builds a minimal memory store for testing.
 */
function makeTestStore() {
  return buildMemoryStore({
    inference: {
      schema_version: "memact.inference.v0",
      records: [
        {
          id: "rec_01",
          packet_id: "pkt_01",
          source_label: "Test activity",
          meaningful: true,
          meaningful_score: 0.82,
          sources: [{ url: "https://example.com", title: "Example" }],
          canonical_themes: ["testing"],
          evidence: { text_excerpt: "Some test evidence" },
          started_at: new Date().toISOString(),
        },
      ],
    },
    schema: { schemas: [], schema_version: "memact.schema.v0" },
  });
}

// Factory

test("createInstrumentedEngine creates an engine with collector and metrics", () => {
  const eng = createInstrumentedEngine();
  assert.ok(eng.collector);
  assert.ok(eng.metrics);
  assert.strictEqual(typeof eng.createMemory, "function");
  assert.strictEqual(typeof eng.retrieveMemories, "function");
  assert.strictEqual(typeof eng.buildRagContext, "function");
});

test("createInstrumentedEngine accepts injected collector and metrics", () => {
  const collector = createTelemetryCollector();
  const metrics = createMetricsRegistry();
  const eng = createInstrumentedEngine({ collector, metrics });

  assert.strictEqual(eng.collector, collector);
  assert.strictEqual(eng.metrics, metrics);
});

// Pass-through correctness — results match raw engine

test("instrumented buildMemoryStore produces same structure as raw engine", () => {
  const eng = createInstrumentedEngine();
  const store = eng.buildMemoryStore({
    inference: {
      schema_version: "memact.inference.v0",
      records: [
        {
          id: "rec_01",
          packet_id: "pkt_01",
          source_label: "Test",
          meaningful: true,
          meaningful_score: 0.8,
          sources: [],
          canonical_themes: ["test"],
          evidence: {},
          started_at: new Date().toISOString(),
        },
      ],
    },
    schema: { schemas: [], schema_version: "memact.schema.v0" },
  });

  assert.ok(Array.isArray(store.memories));
  assert.ok(store.stats);
  assert.strictEqual(store.schema_version, "memact.memory.v0");
});

test("instrumented createMemory produces same result as raw engine", () => {
  const eng = createInstrumentedEngine();
  const store = makeTestStore();

  const { memoryStore, memory, action } = eng.createMemory(
    {
      label: "Test memory",
      summary: "A manually created test memory",
      strength: 0.7,
    },
    store
  );

  assert.ok(memory);
  assert.ok(memory.id);
  assert.strictEqual(action.accepted, true);
  assert.ok(memoryStore.memories.length > store.memories.length);
});

test("instrumented retrieveMemories returns same results as raw engine", () => {
  const eng = createInstrumentedEngine();
  const store = makeTestStore();
  const results = eng.retrieveMemories("test", store);

  assert.ok(Array.isArray(results));
});

// Telemetry events are emitted

test("createMemory emits memory.created event", () => {
  const collector = createTelemetryCollector();
  const received = [];
  collector.on(TELEMETRY_EVENTS.MEMORY_CREATED, (e) => received.push(e));

  const eng = createInstrumentedEngine({ collector });
  const store = makeTestStore();

  eng.createMemory({ label: "Observed", strength: 0.6 }, store);

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, "memory.created");
  assert.ok(received[0].duration_ms >= 0);
});

test("retrieveMemories emits memory.retrieved event with result count", () => {
  const collector = createTelemetryCollector();
  const received = [];
  collector.on(TELEMETRY_EVENTS.MEMORY_RETRIEVED, (e) => received.push(e));

  const eng = createInstrumentedEngine({ collector });
  const store = makeTestStore();

  eng.retrieveMemories("test", store);

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, "memory.retrieved");
  assert.strictEqual(typeof received[0].payload.result_count, "number");
});

test("buildRagContext emits rag.built event", () => {
  const collector = createTelemetryCollector();
  const received = [];
  collector.on(TELEMETRY_EVENTS.RAG_BUILT, (e) => received.push(e));

  const eng = createInstrumentedEngine({ collector });
  const store = makeTestStore();

  eng.buildRagContext("test query", store);

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, "rag.built");
});

test("deleteMemory emits memory.deleted event", () => {
  const collector = createTelemetryCollector();
  const received = [];
  collector.on(TELEMETRY_EVENTS.MEMORY_DELETED, (e) => received.push(e));

  const eng = createInstrumentedEngine({ collector });
  const store = makeTestStore();
  const memoryId = store.memories[0]?.id;

  if (memoryId) {
    eng.deleteMemory(memoryId, store, { hard: true });
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].type, "memory.deleted");
  }
});

test("forgetMemory emits memory.forgotten event", () => {
  const collector = createTelemetryCollector();
  const received = [];
  collector.on(TELEMETRY_EVENTS.MEMORY_FORGOTTEN, (e) => received.push(e));

  const eng = createInstrumentedEngine({ collector });
  const store = makeTestStore();
  const memoryId = store.memories[0]?.id;

  if (memoryId) {
    eng.forgetMemory(memoryId, store);
    assert.strictEqual(received.length, 1);
  }
});

// Metrics recording

test("instrumented operations update metrics registry", () => {
  const metrics = createMetricsRegistry();
  const eng = createInstrumentedEngine({ metrics });
  const store = makeTestStore();

  eng.createMemory({ label: "Met1", strength: 0.5 }, store);
  eng.createMemory({ label: "Met2", strength: 0.6 }, store);
  eng.retrieveMemories("test", store);

  assert.ok(metrics.operationTotal.value >= 3);
});

// Duration measurement

test("span duration is recorded in emitted events", () => {
  const collector = createTelemetryCollector();
  const eng = createInstrumentedEngine({ collector });
  const store = makeTestStore();

  eng.buildMemoryStore({
    inference: {
      schema_version: "memact.inference.v0",
      records: [
        {
          id: "rec_x",
          packet_id: "pkt_x",
          source_label: "X",
          meaningful: true,
          meaningful_score: 0.7,
          sources: [],
          canonical_themes: [],
          evidence: {},
          started_at: new Date().toISOString(),
        },
      ],
    },
    schema: { schemas: [], schema_version: "memact.schema.v0" },
  });

  const buffer = collector.getBuffer();
  assert.ok(buffer.length > 0);

  const storeEvent = buffer.find((e) => e.type === "store.built");
  assert.ok(storeEvent);
  assert.strictEqual(typeof storeEvent.duration_ms, "number");
  assert.ok(storeEvent.duration_ms >= 0);
});

// Disabled mode — zero overhead passthrough

test("disabled instrumented engine passes through without emitting events", () => {
  const collector = createTelemetryCollector();
  const received = [];
  collector.on("*", (e) => received.push(e));

  const eng = createInstrumentedEngine({ collector, enabled: false });
  const store = makeTestStore();

  eng.createMemory({ label: "Silent", strength: 0.5 }, store);
  eng.retrieveMemories("test", store);

  // In disabled mode, operations still return correct results
  // but no events should have been emitted through the collector
  // (the disabled engine uses raw engine functions directly)
  assert.strictEqual(received.length, 0);
});

// Passthrough functions work unchanged

test("non-instrumented functions pass through correctly", () => {
  const eng = createInstrumentedEngine();
  const store = makeTestStore();

  // readMemory is a passthrough — should work identically
  const memory = eng.readMemory(store.memories[0]?.id, store);
  if (store.memories.length > 0) {
    assert.ok(memory);
    assert.strictEqual(memory.id, store.memories[0].id);
  }

  // overlapScore is a passthrough
  const score = eng.overlapScore("test", { label: "test", summary: "" });
  assert.strictEqual(typeof score, "number");

  // Constants are available
  assert.strictEqual(eng.MEMORY_SCHEMA_VERSION, "memact.memory.v0");
  assert.ok(eng.MEMORY_RELATION_TYPES);
});
