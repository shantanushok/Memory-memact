import test from "node:test";
import assert from "node:assert";
import { computeDatabaseSizeBytes, logDatabaseSize, instrumentQuery } from "../src/telemetry.mjs";

test("Memory Consumption Telemetry Logs", async (t) => {

  await t.test("should compute the byte size of a memory store", () => {
    const store = { memories: [{ id: "m_01" }] };
    const size = computeDatabaseSizeBytes(store);
    assert.strictEqual(size, Buffer.byteLength(JSON.stringify(store), "utf8"));
    assert.ok(size > 0);
  });

  await t.test("should log database size with memory count and return the logged entry", () => {
    const logs = [];
    const store = { memories: [{ id: "m_01" }, { id: "m_02" }] };

    const entry = logDatabaseSize(store, (line) => logs.push(line));

    assert.strictEqual(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.event, "database_size");
    assert.strictEqual(parsed.memoryCount, 2);
    assert.strictEqual(entry.memoryCount, 2);
    assert.ok(parsed.bytes > 0);
  });

  await t.test("should handle a store with no memories array", () => {
    const entry = logDatabaseSize({}, () => {});
    assert.strictEqual(entry.memoryCount, 0);
  });

  await t.test("should log query duration and result count without changing the result", () => {
    const logs = [];
    const fakeQuery = (query) => [{ id: "m_01" }, { id: "m_02" }].filter((m) => query !== "none");

    const wrapped = instrumentQuery(fakeQuery, (line) => logs.push(line));
    const result = wrapped("health");

    assert.deepStrictEqual(result, [{ id: "m_01" }, { id: "m_02" }]);
    assert.strictEqual(logs.length, 1);

    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.event, "query_metrics");
    assert.strictEqual(parsed.resultCount, 2);
    assert.ok(typeof parsed.durationMs === "number");
  });

  await t.test("should still log correctly when the wrapped query returns zero results", () => {
    const logs = [];
    const fakeQuery = () => [];

    const wrapped = instrumentQuery(fakeQuery, (line) => logs.push(line));
    wrapped("nothing matches");

    const parsed = JSON.parse(logs[0]);
    assert.strictEqual(parsed.resultCount, 0);
  });
});