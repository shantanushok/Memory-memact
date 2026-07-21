import test from "node:test";
import assert from "node:assert/strict";
import { computeMemoryStats } from "../src/memory-stats.mjs";
import { isLoopbackAddress, createStatsServer } from "../src/stats-server.mjs";

// ---------------------------------------------------------------------------
// activeCount
// ---------------------------------------------------------------------------

test("counts only active records", () => {
  const memories = [
    { id: "a", status: "active" },
    { id: "b", status: "inactive" },
    { id: "c", state: "active" },
    { id: "d", state: "archived" },
  ];
  const { activeCount } = computeMemoryStats(memories);
  assert.equal(activeCount, 2);
});

test("treats records with no status/state as active", () => {
  const memories = [
    { id: "a" },
    { id: "b" },
  ];
  const { activeCount } = computeMemoryStats(memories);
  assert.equal(activeCount, 2);
});

test("excludes expired records from active count", () => {
  const now = Date.now();
  const pastIso = new Date(now - 60_000).toISOString();
  const futureIso = new Date(now + 60_000).toISOString();
  const memories = [
    { id: "a", status: "active", expires_at: pastIso },
    { id: "b", status: "active", expires_at: futureIso },
    { id: "c", status: "active" },
  ];
  const { activeCount } = computeMemoryStats(memories, { now });
  assert.equal(activeCount, 2); // b and c
});

test("returns zero when all records are inactive", () => {
  const memories = [
    { id: "a", status: "inactive" },
    { id: "b", state: "deleted" },
  ];
  const { activeCount } = computeMemoryStats(memories);
  assert.equal(activeCount, 0);
});

test("handles empty memories array", () => {
  const result = computeMemoryStats([]);
  assert.equal(result.activeCount, 0);
  assert.equal(result.averageTtlRemaining, null);
  assert.deepEqual(result.categoryDistribution, {});
});

// ---------------------------------------------------------------------------
// averageTtlRemaining
// ---------------------------------------------------------------------------

test("returns null when no records have TTL", () => {
  const memories = [
    { id: "a", status: "active" },
    { id: "b", status: "active" },
  ];
  const { averageTtlRemaining } = computeMemoryStats(memories);
  assert.equal(averageTtlRemaining, null);
});

test("computes averageTtlRemaining from expires_at", () => {
  const now = 0; // epoch ms
  const memories = [
    { id: "a", status: "active", expires_at: new Date(120_000).toISOString() }, // 120 s remaining
    { id: "b", status: "active", expires_at: new Date(60_000).toISOString() },  // 60 s remaining
  ];
  const { averageTtlRemaining } = computeMemoryStats(memories, { now });
  assert.equal(averageTtlRemaining, 90); // (120 + 60) / 2
});

test("computes averageTtlRemaining from ttl_seconds + created_at", () => {
  const now = 0;
  const memories = [
    {
      id: "a",
      status: "active",
      ttl_seconds: 200,
      created_at: new Date(-100_000).toISOString(), // started 100 s before epoch
      // remaining = (0 + 200) - 100 = 100 s
    },
  ];
  const { averageTtlRemaining } = computeMemoryStats(memories, { now });
  assert.equal(averageTtlRemaining, 100);
});

test("excludes records without TTL from the average", () => {
  const now = 0;
  const memories = [
    { id: "a", status: "active", expires_at: new Date(60_000).toISOString() }, // 60 s
    { id: "b", status: "active" }, // no TTL â excluded from average
  ];
  const { averageTtlRemaining } = computeMemoryStats(memories, { now });
  assert.equal(averageTtlRemaining, 60);
});

test("returns null when all active records have past expiry", () => {
  const now = Date.now();
  const memories = [
    { id: "a", status: "active", expires_at: new Date(now - 10_000).toISOString() },
  ];
  // expired record is not counted as active, so no TTL values exist
  const { averageTtlRemaining, activeCount } = computeMemoryStats(memories, { now });
  assert.equal(activeCount, 0);
  assert.equal(averageTtlRemaining, null);
});

// ---------------------------------------------------------------------------
// categoryDistribution
// ---------------------------------------------------------------------------

test("groups active records by category", () => {
  const memories = [
    { id: "a", status: "active", category: "work" },
    { id: "b", status: "active", category: "personal" },
    { id: "c", status: "active", category: "work" },
    { id: "d", status: "inactive", category: "work" },
  ];
  const { categoryDistribution } = computeMemoryStats(memories);
  assert.equal(categoryDistribution.work, 2);
  assert.equal(categoryDistribution.personal, 1);
  assert.equal(categoryDistribution.work + categoryDistribution.personal, 3);
});

test("defaults missing category to 'general'", () => {
  const memories = [
    { id: "a", status: "active" },
    { id: "b", status: "active" },
  ];
  const { categoryDistribution } = computeMemoryStats(memories);
  assert.equal(categoryDistribution.general, 2);
});

test("mixes explicit and default categories correctly", () => {
  const memories = [
    { id: "a", status: "active", category: "work" },
    { id: "b", status: "active" },
  ];
  const { categoryDistribution } = computeMemoryStats(memories);
  assert.equal(categoryDistribution.work, 1);
  assert.equal(categoryDistribution.general, 1);
});

// ---------------------------------------------------------------------------
// isLoopbackAddress
// ---------------------------------------------------------------------------

test("isLoopbackAddress returns true for 127.0.0.1", () => {
  assert.ok(isLoopbackAddress("127.0.0.1"));
});

test("isLoopbackAddress returns true for ::1", () => {
  assert.ok(isLoopbackAddress("::1"));
});

test("isLoopbackAddress returns true for ::ffff:127.0.0.1", () => {
  assert.ok(isLoopbackAddress("::ffff:127.0.0.1"));
});

test("isLoopbackAddress returns false for an external IP", () => {
  assert.ok(!isLoopbackAddress("192.168.1.100"));
});

test("isLoopbackAddress returns false for 0.0.0.0", () => {
  assert.ok(!isLoopbackAddress("0.0.0.0"));
});

test("isLoopbackAddress returns false for empty string", () => {
  assert.ok(!isLoopbackAddress(""));
});

// ---------------------------------------------------------------------------
// createStatsServer telemetry logging
// ---------------------------------------------------------------------------

test("createStatsServer logs database size on each stats request", async () => {
  const logs = [];
  const fakeMemories = [{ id: "m_01", status: "active" }, { id: "m_02", status: "active" }];

  const server = createStatsServer({
    loadMemories: async () => fakeMemories,
    logger: (line) => logs.push(line),
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/`);
  await response.json();

  await new Promise((resolve) => server.close(resolve));

  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.event, "database_size");
  assert.equal(parsed.memoryCount, 2);
});
