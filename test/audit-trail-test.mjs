import assert from "node:assert";
import { createInstrumentedEngine } from "../src/instrumented-engine.mjs";
import { createTelemetryCollector, TELEMETRY_EVENTS } from "../src/telemetry.mjs";

console.log("Running Query Audit Trail Compliance Verification...");

const mockStore = {
  memories: [
    { label: "Sample active node record", strength: 0.85, type: "activity_memory", state: "active" }
  ]
};

// Create a telemetry-instrumented engine and capture events
const collector = createTelemetryCollector();
const auditEvents = [];
collector.on(TELEMETRY_EVENTS.MEMORY_RETRIEVED, (event) => auditEvents.push(event));

const eng = createInstrumentedEngine({ collector });

// Execute standard query — audit data is now captured via telemetry events
const results = eng.retrieveMemories("Sample", mockStore, {
  clientId: "compliance_test_client_44",
  fieldPath: "user.profile.memories"
});

assert.ok(auditEvents.length > 0, "Audit telemetry event must be emitted on retrieval.");
assert.strictEqual(auditEvents[0].type, "memory.retrieved");
assert.ok(typeof auditEvents[0].payload.result_count === "number");
assert.ok(auditEvents[0].duration_ms >= 0, "Duration must be recorded.");

console.log("✅ Query audit trail tracking (via telemetry) behaves perfectly!");