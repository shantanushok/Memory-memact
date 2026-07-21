/**
 * Instrumented engine wrapper for Memact Memory.
 *
 * Provides a factory that decorates every public engine function with
 * telemetry instrumentation — span timing, event emission, and metrics
 * recording — without modifying the original engine logic.
 *
 * @module instrumented-engine
 */

import * as engine from "./engine.mjs";
import {
  createTelemetryCollector,
  TELEMETRY_EVENTS,
} from "./telemetry.mjs";
import { createMetricsRegistry } from "./telemetry-metrics.mjs";

/**
 * Wraps a synchronous engine function with span-based telemetry.
 * @param {Object} collector - Telemetry collector instance
 * @param {Object} metrics - Metrics registry instance
 * @param {string} eventType - TELEMETRY_EVENTS value
 * @param {Function} fn - The original engine function
 * @param {Function} [extractPayload] - Extracts telemetry payload from args + result
 * @returns {Function} Instrumented version with identical return shape
 */
function instrumentSync(collector, metrics, eventType, fn, extractPayload) {
  return function instrumented(...args) {
    const span = collector.startSpan(eventType);
    try {
      const result = fn(...args);
      const payload = extractPayload ? extractPayload(args, result) : {};
      const event = span.end(payload);
      metrics.operationTotal.inc(1, { type: eventType });
      if (event && event.duration_ms != null) {
        metrics.operationDuration.observe(event.duration_ms);
      }
      return result;
    } catch (error) {
      span.end({ error: error.message });
      metrics.errorTotal.inc(1, { type: eventType });
      throw error;
    }
  };
}

/**
 * Creates an instrumented engine instance where every public operation
 * emits telemetry events and records metrics.
 *
 * @param {Object} [options={}]
 * @param {Object} [options.collector] - Existing telemetry collector (auto-created if absent)
 * @param {Object} [options.metrics] - Existing metrics registry (auto-created if absent)
 * @param {boolean} [options.enabled=true] - Master toggle for instrumentation
 * @returns {Object} Instrumented engine with `collector` and `metrics` properties
 *
 * @example
 * const eng = createInstrumentedEngine();
 *
 * // Use exactly like the raw engine — same signatures, same return shapes
 * const { memoryStore, memory, action } = eng.createMemory(input, store);
 *
 * // Access telemetry
 * const events = eng.collector.flush();
 * const metricsSnapshot = eng.metrics.snapshot();
 */
export function createInstrumentedEngine(options = {}) {
  const collector =
    options.collector || createTelemetryCollector(options);
  const metrics = options.metrics || createMetricsRegistry();

  // If disabled, pass through all raw engine functions with no overhead
  if (options.enabled === false) {
    return Object.freeze({
      collector,
      metrics,
      // Re-export all engine functions unchanged
      buildMemoryStore: engine.buildMemoryStore,
      createMemory: engine.createMemory,
      readMemory: engine.readMemory,
      listMemories: engine.listMemories,
      updateMemory: engine.updateMemory,
      deleteMemory: engine.deleteMemory,
      retrieveMemories: engine.retrieveMemories,
      retrieveCognitiveSchemas: engine.retrieveCognitiveSchemas,
      buildRagContext: engine.buildRagContext,
      rememberPacket: engine.rememberPacket,
      rememberInferenceRecord: engine.rememberInferenceRecord,
      rememberSchemaPacket: engine.rememberSchemaPacket,
      rememberFeatureOutput: engine.rememberFeatureOutput,
      rememberSchema: engine.rememberSchema,
      rememberIntent: engine.rememberIntent,
      reinforceMemory: engine.reinforceMemory,
      weakenMemory: engine.weakenMemory,
      forgetMemory: engine.forgetMemory,
      linkMemories: engine.linkMemories,
      relateMemories: engine.relateMemories,
      assimilateEvidence: engine.assimilateEvidence,
      accommodateSchema: engine.accommodateSchema,
      supersedeMemory: engine.supersedeMemory,
      retrieveIntents: engine.retrieveIntents,
      linkIntentToSchema: engine.linkIntentToSchema,
      linkIntentToEvidence: engine.linkIntentToEvidence,
      getMemoryTimeline: engine.getMemoryTimeline,
      queryMemoryGraph: engine.queryMemoryGraph,
      getMemoryGraph: engine.getMemoryGraph,
      explainMemory: engine.explainMemory,
      formatMemoryReport: engine.formatMemoryReport,
      reindexMemoryStore: engine.reindexMemoryStore,
      overlapScore: engine.overlapScore,
      queryContextWithCache: engine.queryContextWithCache,
      clearQueryCache: engine.clearQueryCache,
      listMemoryRecords: engine.listMemoryRecords,
      retrieveContext: engine.retrieveContext,
      retrieveSchemaPackets: engine.retrieveSchemaPackets,
      createCorrection: engine.createCorrection,
      buildContextForFeature: engine.buildContextForFeature,
      trainMediaBaseline: engine.trainMediaBaseline,
      detectSessionAnomaly: engine.detectSessionAnomaly,
      clearMediaBaseline: engine.clearMediaBaseline,
      purgeExpiredRecords: engine.purgeExpiredRecords,
      appendCommitLog: engine.appendCommitLog,
      getCommitJournal: engine.getCommitJournal,
      clearCommitJournal: engine.clearCommitJournal,
      // Constants
      MEMORY_SCHEMA_VERSION: engine.MEMORY_SCHEMA_VERSION,
      MEMORY_RELATION_TYPES: engine.MEMORY_RELATION_TYPES,
    });
  }

  return Object.freeze({
    collector,
    metrics,

    // --- Store lifecycle ---

    buildMemoryStore: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.STORE_BUILT,
      engine.buildMemoryStore,
      (_args, result) => ({
        memory_count: result?.memories?.length || 0,
        relation_count: result?.relations?.length || 0,
      })
    ),

    reindexMemoryStore: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.STORE_REINDEXED,
      engine.reindexMemoryStore,
      (_args, result) => ({
        memory_count: result?.memories?.length || 0,
      })
    ),

    // --- CRUD ---

    createMemory: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_CREATED,
      engine.createMemory,
      (_args, result) => ({
        memory_id: result?.memory?.id,
        accepted: result?.action?.accepted,
      })
    ),

    readMemory: engine.readMemory,

    listMemories: engine.listMemories,

    updateMemory: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_UPDATED,
      engine.updateMemory,
      (_args, result) => ({
        memory_id: result?.memory?.id,
        accepted: result?.action?.accepted,
        patch_keys: result?.action?.payload?.patch_keys,
      })
    ),

    deleteMemory: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_DELETED,
      engine.deleteMemory,
      (args, result) => ({
        memory_id: args[0],
        accepted: result?.action?.accepted,
        hard: args[2]?.hard || false,
      })
    ),

    // --- Retrieval ---

    retrieveMemories: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_RETRIEVED,
      engine.retrieveMemories,
      (args, result) => {
        const results = Array.isArray(result) ? result : [];
        // Record retrieval score distribution
        for (const mem of results) {
          if (mem.retrieval_score != null) {
            metrics.retrievalScoreDistribution.observe(mem.retrieval_score);
          }
        }
        return {
          query: String(args[0] || "").slice(0, 120),
          result_count: results.length,
          client_id: results.auditTrailLog?.client_id,
          queried_path: results.auditTrailLog?.queried_path,
        };
      }
    ),

    retrieveCognitiveSchemas: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.QUERY_EXECUTED,
      engine.retrieveCognitiveSchemas,
      (args, result) => ({
        query: String(args[0] || "").slice(0, 120),
        result_count: Array.isArray(result) ? result.length : 0,
        type: "cognitive_schemas",
      })
    ),

    buildRagContext: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.RAG_BUILT,
      engine.buildRagContext,
      (args, result) => ({
        query: String(args[0] || "").slice(0, 120),
        context_item_count: result?.context_items?.length || 0,
        source_count: result?.stats?.source_count || 0,
      })
    ),

    // --- Remember operations ---

    rememberPacket: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.PACKET_REMEMBERED,
      engine.rememberPacket,
      (_args, result) => ({
        accepted: result?.action?.accepted,
        memory_id: result?.action?.memory_id,
      })
    ),

    rememberInferenceRecord: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.PACKET_REMEMBERED,
      engine.rememberInferenceRecord,
      (_args, result) => ({
        accepted: result?.action?.accepted,
      })
    ),

    rememberSchemaPacket: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.SCHEMA_REMEMBERED,
      engine.rememberSchemaPacket,
      (_args, result) => ({
        accepted: result?.action?.accepted,
        memory_id: result?.memory?.id,
      })
    ),

    rememberFeatureOutput: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_CREATED,
      engine.rememberFeatureOutput,
      (_args, result) => ({
        accepted: result?.action?.accepted,
        memory_id: result?.memory?.id,
        type: "feature_output",
      })
    ),

    rememberSchema: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.SCHEMA_REMEMBERED,
      engine.rememberSchema,
      (_args, result) => ({
        accepted: result?.action?.accepted,
      })
    ),

    rememberIntent: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.INTENT_REMEMBERED,
      engine.rememberIntent,
      (_args, result) => ({
        accepted: result?.action?.accepted,
        intent_count: result?.memories?.length || 0,
      })
    ),

    // --- Strength mutations ---

    reinforceMemory: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_REINFORCED,
      engine.reinforceMemory,
      (args, result) => ({
        memory_id: args[0],
        accepted: result?.action?.accepted,
      })
    ),

    weakenMemory: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_WEAKENED,
      engine.weakenMemory,
      (args, result) => ({
        memory_id: args[0],
        accepted: result?.action?.accepted,
      })
    ),

    forgetMemory: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_FORGOTTEN,
      engine.forgetMemory,
      (args, result) => ({
        memory_id: args[0],
        accepted: result?.action?.accepted,
      })
    ),

    // --- Relations ---

    linkMemories: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.RELATION_ADDED,
      engine.linkMemories,
      (args) => ({
        from: args[0],
        to: args[1],
        relation: args[3] || "related",
      })
    ),

    relateMemories: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.RELATION_ADDED,
      engine.relateMemories,
      (args, result) => ({
        from: args[0],
        to: args[1],
        relation: args[2],
        accepted: result?.action?.accepted,
      })
    ),

    // --- Schema operations ---

    assimilateEvidence: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.SCHEMA_ASSIMILATED,
      engine.assimilateEvidence,
      (args, result) => ({
        memory_id: args[0],
        accepted: result?.action?.accepted,
      })
    ),

    accommodateSchema: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.SCHEMA_ACCOMMODATED,
      engine.accommodateSchema,
      (_args, result) => ({
        memory_id: result?.memory?.id,
        accepted: result?.action?.accepted,
      })
    ),

    supersedeMemory: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.MEMORY_SUPERSEDED,
      engine.supersedeMemory,
      (args, result) => ({
        memory_id: args[0],
        replacement_id: result?.memory?.id,
        accepted: result?.action?.accepted,
      })
    ),

    // --- Intent ---

    retrieveIntents: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.QUERY_EXECUTED,
      engine.retrieveIntents,
      (args, result) => ({
        query: String(args[0] || "").slice(0, 120),
        result_count: Array.isArray(result) ? result.length : 0,
        type: "intents",
      })
    ),

    linkIntentToSchema: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.RELATION_ADDED,
      engine.linkIntentToSchema,
      (args, result) => ({
        from: args[0],
        to: args[1],
        relation: "builds_on",
        accepted: result?.action?.accepted,
      })
    ),

    linkIntentToEvidence: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.RELATION_ADDED,
      engine.linkIntentToEvidence,
      (args, result) => ({
        from: args[0],
        to: args[1],
        relation: "evidenced_by",
        accepted: result?.action?.accepted,
      })
    ),

    // --- Correction ---

    createCorrection: instrumentSync(
      collector,
      metrics,
      TELEMETRY_EVENTS.CORRECTION_CREATED,
      engine.createCorrection,
      (args, result) => ({
        memory_id: args[0],
        accepted: result?.action?.accepted,
      })
    ),

    // --- Graph / timeline / explain ---

    getMemoryTimeline: engine.getMemoryTimeline,
    queryMemoryGraph: engine.queryMemoryGraph,
    getMemoryGraph: engine.getMemoryGraph,
    explainMemory: engine.explainMemory,
    formatMemoryReport: engine.formatMemoryReport,

    // --- Utility passthrough ---

    overlapScore: engine.overlapScore,
    queryContextWithCache: engine.queryContextWithCache,
    clearQueryCache: engine.clearQueryCache,
    listMemoryRecords: engine.listMemoryRecords,
    retrieveContext: engine.retrieveContext,
    retrieveSchemaPackets: engine.retrieveSchemaPackets,
    buildContextForFeature: engine.buildContextForFeature,
    trainMediaBaseline: engine.trainMediaBaseline,
    detectSessionAnomaly: engine.detectSessionAnomaly,
    clearMediaBaseline: engine.clearMediaBaseline,
    purgeExpiredRecords: engine.purgeExpiredRecords,
    appendCommitLog: engine.appendCommitLog,
    getCommitJournal: engine.getCommitJournal,
    clearCommitJournal: engine.clearCommitJournal,

    // --- Constants ---

    MEMORY_SCHEMA_VERSION: engine.MEMORY_SCHEMA_VERSION,
    MEMORY_RELATION_TYPES: engine.MEMORY_RELATION_TYPES,
  });
}
