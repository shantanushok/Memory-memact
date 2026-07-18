import test from "node:test";
import assert from "node:assert/strict";
import {
  createCounter,
  createGauge,
  createHistogram,
  createMetricsRegistry,
} from "../src/telemetry-metrics.mjs";

// Counter

test("counter starts at zero", () => {
  const c = createCounter("test_counter", "A test counter");
  assert.strictEqual(c.value, 0);
  assert.strictEqual(c.name, "test_counter");
  assert.strictEqual(c.kind, "counter");
});

test("counter.inc increments by amount", () => {
  const c = createCounter("ops");
  c.inc(3);
  assert.strictEqual(c.value, 3);
  c.inc();
  assert.strictEqual(c.value, 4);
});

test("counter.inc ignores negative amounts", () => {
  const c = createCounter("ops");
  c.inc(5);
  c.inc(-2);
  assert.strictEqual(c.value, 5);
});

test("counter.inc tracks labeled values", () => {
  const c = createCounter("ops");
  c.inc(1, { type: "create" });
  c.inc(1, { type: "create" });
  c.inc(1, { type: "delete" });

  assert.strictEqual(c.value, 3);
  assert.strictEqual(c.valueOf({ type: "create" }), 2);
  assert.strictEqual(c.valueOf({ type: "delete" }), 1);
  assert.strictEqual(c.valueOf({ type: "update" }), 0);
});

test("counter.reset resets to zero", () => {
  const c = createCounter("ops");
  c.inc(10);
  c.inc(5, { type: "a" });
  c.reset();
  assert.strictEqual(c.value, 0);
  assert.strictEqual(c.valueOf({ type: "a" }), 0);
});

test("counter.snapshot returns serializable object", () => {
  const c = createCounter("ops");
  c.inc(3);
  c.inc(2, { region: "us" });
  const snap = c.snapshot();

  assert.strictEqual(snap.name, "ops");
  assert.strictEqual(snap.kind, "counter");
  assert.strictEqual(snap.value, 5);
  assert.strictEqual(typeof snap.labels, "object");
});

// Gauge

test("gauge starts at zero", () => {
  const g = createGauge("memory_count");
  assert.strictEqual(g.value, 0);
  assert.strictEqual(g.kind, "gauge");
});

test("gauge.set sets absolute value", () => {
  const g = createGauge("memory_count");
  g.set(42);
  assert.strictEqual(g.value, 42);
  g.set(0);
  assert.strictEqual(g.value, 0);
});

test("gauge.inc and gauge.dec adjust value", () => {
  const g = createGauge("connections");
  g.inc(5);
  assert.strictEqual(g.value, 5);
  g.dec(2);
  assert.strictEqual(g.value, 3);
  g.dec();
  assert.strictEqual(g.value, 2);
});

test("gauge allows negative values", () => {
  const g = createGauge("balance");
  g.dec(10);
  assert.strictEqual(g.value, -10);
});

test("gauge.reset resets to zero", () => {
  const g = createGauge("count");
  g.set(100);
  g.reset();
  assert.strictEqual(g.value, 0);
});

test("gauge.snapshot returns serializable object", () => {
  const g = createGauge("size_bytes", "Database size");
  g.set(1024);
  const snap = g.snapshot();

  assert.strictEqual(snap.name, "size_bytes");
  assert.strictEqual(snap.kind, "gauge");
  assert.strictEqual(snap.value, 1024);
});

// Histogram

test("histogram starts empty", () => {
  const h = createHistogram("duration_ms");
  assert.strictEqual(h.count, 0);
  assert.strictEqual(h.sum, 0);
  assert.strictEqual(h.min, 0);
  assert.strictEqual(h.max, 0);
  assert.strictEqual(h.avg, 0);
});

test("histogram.observe records values correctly", () => {
  const h = createHistogram("duration_ms");
  h.observe(10);
  h.observe(20);
  h.observe(30);

  assert.strictEqual(h.count, 3);
  assert.strictEqual(h.sum, 60);
  assert.strictEqual(h.min, 10);
  assert.strictEqual(h.max, 30);
  assert.strictEqual(h.avg, 20);
});

test("histogram.percentile calculates correct values", () => {
  const h = createHistogram("scores");
  // Add 100 observations: 1, 2, 3, ..., 100
  for (let i = 1; i <= 100; i++) {
    h.observe(i);
  }

  assert.strictEqual(h.percentile(0.5), 50);
  assert.strictEqual(h.percentile(0.9), 90);
  assert.strictEqual(h.percentile(0.99), 99);
  assert.strictEqual(h.percentile(1.0), 100);
});

test("histogram.percentile returns 0 for empty histogram", () => {
  const h = createHistogram("empty");
  assert.strictEqual(h.percentile(0.5), 0);
});

test("histogram respects maxSamples", () => {
  const h = createHistogram("constrained", { maxSamples: 5 });
  for (let i = 0; i < 20; i++) {
    h.observe(i);
  }
  // count tracks all observations, but percentile uses only retained samples
  assert.strictEqual(h.count, 20);
  // p50 of last 5 values [15,16,17,18,19] should be 17
  assert.strictEqual(h.percentile(0.5), 17);
});

test("histogram.reset clears all state", () => {
  const h = createHistogram("resettable");
  h.observe(10);
  h.observe(20);
  h.reset();

  assert.strictEqual(h.count, 0);
  assert.strictEqual(h.sum, 0);
  assert.strictEqual(h.min, 0);
  assert.strictEqual(h.max, 0);
});

test("histogram.snapshot returns serializable object with percentiles", () => {
  const h = createHistogram("latency", {
    percentiles: [0.5, 0.95],
  });
  h.observe(10);
  h.observe(20);
  h.observe(30);

  const snap = h.snapshot();
  assert.strictEqual(snap.name, "latency");
  assert.strictEqual(snap.kind, "histogram");
  assert.strictEqual(snap.count, 3);
  assert.ok("p50" in snap.percentiles);
  assert.ok("p95" in snap.percentiles);
});

// MetricsRegistry

test("createMetricsRegistry has all standard instruments", () => {
  const reg = createMetricsRegistry();

  assert.strictEqual(reg.operationTotal.kind, "counter");
  assert.strictEqual(reg.errorTotal.kind, "counter");
  assert.strictEqual(reg.memoryCount.kind, "counter");
  assert.strictEqual(reg.operationDuration.kind, "histogram");
  assert.strictEqual(reg.retrievalScoreDistribution.kind, "histogram");
  assert.strictEqual(reg.memoryStrengthDistribution.kind, "histogram");
  assert.strictEqual(reg.activeMemoryCount.kind, "gauge");
  assert.strictEqual(reg.relationCount.kind, "gauge");
  assert.strictEqual(reg.cacheSize.kind, "gauge");
  assert.strictEqual(reg.databaseSizeBytes.kind, "gauge");
});

test("registry.snapshot returns all instrument snapshots", () => {
  const reg = createMetricsRegistry();
  reg.operationTotal.inc(5);
  reg.activeMemoryCount.set(42);
  reg.operationDuration.observe(12.5);

  const snap = reg.snapshot();
  assert.strictEqual(snap.operationTotal.value, 5);
  assert.strictEqual(snap.activeMemoryCount.value, 42);
  assert.strictEqual(snap.operationDuration.count, 1);
});

test("registry.reset clears all instruments", () => {
  const reg = createMetricsRegistry();
  reg.operationTotal.inc(10);
  reg.activeMemoryCount.set(50);
  reg.operationDuration.observe(100);

  reg.reset();

  const snap = reg.snapshot();
  assert.strictEqual(snap.operationTotal.value, 0);
  assert.strictEqual(snap.activeMemoryCount.value, 0);
  assert.strictEqual(snap.operationDuration.count, 0);
});
