import { cosineSimilarity } from "./embeddings.mjs";
import { auditContextLeakage } from "./audit.mjs";
import { validateVectorSearchAccess } from "./auth/oauth.mjs";

export const MEMORY_SCHEMA_VERSION = "memact.memory.v0";
const DEFAULT_RETENTION_THRESHOLD = 0.34;
const DEFAULT_DECAY_PER_DAY = 0.006;
const MAX_SOURCES = 8;
const DEFAULT_RAG_TOP = 6;
// Local query cache for repetitive app context queries
const queryCache = new Map();

export const MEMORY_RELATION_TYPES = Object.freeze({
  ASSIMILATES: "assimilates",
  ACCOMMODATES: "accommodates",
  REINFORCES: "reinforces",
  WEAKENS: "weakens",
  CONTRADICTS: "contradicts",
  TRIGGERS: "triggers",
  BUILDS_ON: "builds_on",
  SUPPORTS: "supports",
  UPDATES: "updates",
  SUPERSEDES: "supersedes",
  SUPERSEDED_BY: "superseded_by",
  CO_OCCURS_WITH: "co_occurs_with",
  EVIDENCED_BY: "evidenced_by",
  RELATED: "related",
});

const RELATION_METADATA = Object.freeze({
  [MEMORY_RELATION_TYPES.ASSIMILATES]: { category: "schema_lifecycle", directed: true, defaultWeight: 0.74 },
  [MEMORY_RELATION_TYPES.ACCOMMODATES]: { category: "schema_lifecycle", directed: true, defaultWeight: 0.72 },
  [MEMORY_RELATION_TYPES.REINFORCES]: { category: "schema_lifecycle", directed: true, defaultWeight: 0.7 },
  [MEMORY_RELATION_TYPES.WEAKENS]: { category: "schema_lifecycle", directed: true, defaultWeight: 0.45 },
  [MEMORY_RELATION_TYPES.CONTRADICTS]: { category: "schema_lifecycle", directed: false, defaultWeight: 0.68 },
  [MEMORY_RELATION_TYPES.TRIGGERS]: { category: "influence", directed: true, defaultWeight: 0.62 },
  [MEMORY_RELATION_TYPES.BUILDS_ON]: { category: "learning", directed: true, defaultWeight: 0.64 },
  [MEMORY_RELATION_TYPES.SUPPORTS]: { category: "evidence", directed: true, defaultWeight: 0.72 },
  [MEMORY_RELATION_TYPES.UPDATES]: { category: "schema_lifecycle", directed: true, defaultWeight: 0.66 },
  [MEMORY_RELATION_TYPES.SUPERSEDES]: { category: "schema_lifecycle", directed: true, defaultWeight: 0.82 },
  [MEMORY_RELATION_TYPES.SUPERSEDED_BY]: { category: "schema_lifecycle", directed: true, defaultWeight: 0.82 },
  [MEMORY_RELATION_TYPES.CO_OCCURS_WITH]: { category: "association", directed: false, defaultWeight: 0.52 },
  [MEMORY_RELATION_TYPES.EVIDENCED_BY]: { category: "evidence", directed: true, defaultWeight: 0.78 },
  [MEMORY_RELATION_TYPES.RELATED]: { category: "association", directed: false, defaultWeight: 0.5 },
});

function normalize(value, maxLength = 0) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3).trim()}...`;
  }
  return text;
}

function slug(value) {
  return normalize(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "memory";
}

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => normalize(value)).filter(Boolean))];
}

function clamp(value, min = 0, max = 1) {
  const number = Number(value || 0);
  return Math.max(min, Math.min(max, Number(number.toFixed(4))));
}

function nowIso() {
  return new Date().toISOString();
}

function relationId(fromId, toId, type) {
  return `relation:${slug(fromId)}:${slug(type)}:${slug(toId)}`;
}

function normalizeRelationType(type) {
  const normalized = normalize(type, 80).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return Object.values(MEMORY_RELATION_TYPES).includes(normalized) ? normalized : MEMORY_RELATION_TYPES.RELATED;
}

function normalizeRelationInput(input = {}) {
  const from = normalize(input.from || input.from_id || input.source_id);
  const to = normalize(input.to || input.to_id || input.target_id);
  const type = normalizeRelationType(input.type || input.relation || MEMORY_RELATION_TYPES.RELATED);
  const metadata = RELATION_METADATA[type] || RELATION_METADATA[MEMORY_RELATION_TYPES.RELATED];
  const validFrom = normalize(input.valid_from || input.occurred_at || input.recorded_at || nowIso(), 80);
  return {
    id: normalize(input.id) || relationId(from, to, type),
    from,
    to,
    type,
    category: normalize(input.category || metadata.category),
    directed: input.directed ?? metadata.directed,
    weight: clamp(input.weight ?? metadata.defaultWeight),
    confidence: clamp(input.confidence ?? input.weight ?? metadata.defaultWeight),
    evidence: {
      reason: normalize(input.evidence?.reason || input.reason, 260),
      sources: dedupeSources(input.evidence?.sources || input.sources || [], 4),
      packet_ids: unique(input.evidence?.packet_ids || input.packet_ids),
    },
    valid_from: validFrom,
    valid_until: normalize(input.valid_until, 80),
    recorded_at: normalize(input.recorded_at || nowIso(), 80),
    invalidated_by: normalize(input.invalidated_by),
  };
}

function parseTime(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function daysSince(value, now = Date.now()) {
  const timestamp = parseTime(value);
  if (!timestamp) return 0;
  return Math.max(0, (now - timestamp) / 86400000);
}

function normalizeSource(source = {}) {
  const url = normalize(source.url, 500);
  const domain = normalize(source.domain, 120) || domainFromUrl(url);
  const title = normalize(source.title, 180) || domain || url || "Untitled source";
  return {
    url,
    domain,
    title,
    occurred_at: normalize(source.occurred_at, 80),
    application: normalize(source.application, 80),
  };
}

function domainFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function dedupeSources(sources = [], limit = MAX_SOURCES) {
  const seen = new Set();
  const output = [];
  for (const raw of Array.isArray(sources) ? sources : []) {
    const source = normalizeSource(raw);
    const key = source.url || `${source.domain}|${source.title}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(source);
    if (output.length >= limit) break;
  }
  return output;
}

function tokenSet(value) {
  return new Set(
    normalize(value)
      .toLowerCase()
      .replace(/[^a-z0-9@#./+-]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3)
  );
}

// Lightweight fuzzy string similarity parser using Jaro-Winkler approximate alignment
function calculateFuzzyMatchScore(stringA, stringB) {
  const s1 = (stringA || "").toLowerCase().trim();
  const s2 = (stringB || "").toLowerCase().trim();

  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(s2.length, i + matchWindow + 1);

    for (let j = start; j < end; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (s1Matches[i]) {
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }
  }

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;
  return Number(jaro.toFixed(4));
}

// Update or extend the current overlapScore strategy to support fuzzy indexing queries
export function overlapScore(query, memory) {
  const queryString = String(query || "").trim();
  const labelString = String(memory?.label || "").trim();
  const summaryString = String(memory?.summary || "").trim();

  // Primary exact checking passes
  if (labelString.toLowerCase().includes(queryString.toLowerCase())) return 1.0;

  // Fuzzy alignment resolution fallback for handling large-scale typos or partial queries
  const labelFuzzy = calculateFuzzyMatchScore(queryString, labelString);
  const summaryFuzzy = calculateFuzzyMatchScore(queryString, summaryString);

  const highestFuzzyScore = Math.max(labelFuzzy, summaryFuzzy);

  // Return fuzzy matching score if it meets a reasonable confidence threshold (e.g., > 0.65)
  return highestFuzzyScore > 0.65 ? highestFuzzyScore : 0.0;
}

/**
 * Executes a query over the memory store using a local cache to optimize repetitive requests.
 */
export function queryContextWithCache(query, memories, options = {}) {
  if (!query || !Array.isArray(memories)) return [];

  // Generate a unique cache key based on the query text and current memory structure
  const cacheKey = `${query}:${memories.map(m => `${m.id}-${m.strength}`).join(',')}`;

  if (queryCache.has(cacheKey)) {
    return queryCache.get(cacheKey);
  }

  // Cache miss: Calculate overlap scores across memories
  const results = memories
    .map((memory) => ({
      memory,
      score: overlapScore(query, memory)
    }))
    .filter((res) => res.score >= (options.threshold || 0.1))
    .sort((a, b) => b.score - a.score);

  queryCache.set(cacheKey, results);
  return results;
}

/**
 * Clears the query cache whenever the underlying memory database changes.
 */
export function clearQueryCache() {
  queryCache.clear();
}
function activityMemoryFromRecord(record, options = {}) {
  const threshold = Number(options.retentionThreshold ?? DEFAULT_RETENTION_THRESHOLD);
  const sourcePacketId = normalize(record.packet_id || record.packet?.id || `packet:${record.id}`);
  const sources = dedupeSources(record.sources || record.packet?.sources);
  const themes = unique(record.canonical_themes || record.packet?.canonical_themes);
  const meaningfulScore = clamp(record.meaningful_score ?? record.packet?.meaningful_score ?? 0);
  const sourceScore = sources.length ? 0.08 : 0;
  const themeScore = themes.length ? 0.08 : 0;
  const survivalScore = clamp((meaningfulScore * 0.82) + sourceScore + themeScore);

  if (record.meaningful === false || survivalScore < threshold) {
    return null;
  }

  return {
    id: `memory:activity:${slug(sourcePacketId)}`,
    type: "activity_memory",
    label: normalize(record.source_label || record.packet?.label || record.evidence?.title || "Activity memory", 180),
    summary: normalize(record.evidence?.text_excerpt || record.packet?.evidence?.text_excerpt, 360),
    strength: survivalScore,
    survival_score: survivalScore,
    meaningful_score: meaningfulScore,
    source_packet_id: sourcePacketId,
    source_record_id: normalize(record.id || record.packet?.source_record_id),
    themes,
    sources,
    reasons: unique(record.meaning_reasons || record.packet?.reasons),
    first_seen_at: normalize(record.started_at || record.packet?.started_at || sources[0]?.occurred_at),
    last_seen_at: normalize(record.ended_at || record.packet?.ended_at || record.started_at || sources[0]?.occurred_at),
    provenance: {
      system: "inference",
      claim_type: "meaning_packet",
      packet_id: sourcePacketId,
    },
    state: "active",
  };
}

function schemaMemoryFromSchema(schema) {
  const id = normalize(schema?.id);
  if (!id) return null;
  const packet = schema.virtual_schema_packet || schema.schema_packet || {};
  const evidenceRecords = Array.isArray(schema.evidence_records) ? schema.evidence_records : [];
  const evidenceStrength = evidenceRecords.length
    ? evidenceRecords.reduce((sum, record) => sum + Number(record.meaningful_score ?? 1), 0) / evidenceRecords.length
    : 0.5;
  const confidence = Number(schema.confidence ?? 0);
  const support = Number(schema.support ?? 0);
  const markerCategoryCount = Array.isArray(schema.marker_categories) ? schema.marker_categories.length : 0;
  const markerCoverage = Math.min(1, markerCategoryCount / 3);
  const strength = clamp((confidence * 0.48) + (Math.min(1, support / 8) * 0.22) + (evidenceStrength * 0.18) + (markerCoverage * 0.12));
  const evidencePacketIds = unique([
    ...(packet.evidence_packet_ids || []),
    ...evidenceRecords.map((record) => normalize(record.packet_id || `packet:${record.id}`)),
  ]);
  const sources = dedupeSources([
    ...(packet.sources || []),
    ...evidenceRecords.flatMap((record) => record.sources || []),
  ]);

  return {
    id: `memory:schema:${slug(id)}`,
    type: "cognitive_schema_memory",
    label: normalize(packet.label || schema.label || id, 160),
    summary: normalize(schema.summary || packet.summary, 360),
    virtual: true,
    cognitive_schema: true,
    strength,
    survival_score: strength,
    schema_id: id,
    schema_packet_id: normalize(packet.id || `schema_packet:${id}`),
    schema_state: normalize(schema.state),
    state_label: normalize(schema.state_label),
    core_interpretation: normalize(packet.core_interpretation || schema.core_interpretation, 280),
    action_tendency: normalize(packet.action_tendency || schema.action_tendency, 240),
    emotional_signature: unique(packet.emotional_signature || schema.emotional_signature),
    marker_categories: unique(packet.marker_categories || schema.marker_categories),
    matched_markers: unique(packet.matched_markers || schema.matched_markers),
    formation_basis: normalize(schema.formation_basis, 500),
    formation_metrics: schema.formation_metrics || packet.formation_metrics || {},
    support,
    confidence,
    themes: unique(packet.matched_themes || schema.matched_themes),
    evidence_packet_ids: evidencePacketIds,
    sources,
    provenance: {
      system: "schema",
      claim_type: "virtual_cognitive_schema_packet",
      schema_packet_id: normalize(packet.id || `schema_packet:${id}`),
      schema_id: id,
      guardrail: normalize(schema.language_guardrail),
    },
    state: "active",
  };
}

function intentMemoriesFromResult(intentResult = {}) {
  if (!intentResult) return [];
  const intents = Array.isArray(intentResult.predicted_intents)
    ? intentResult.predicted_intents
    : Array.isArray(intentResult.intents)
      ? intentResult.intents
      : intentResult.id
        ? [intentResult]
        : [];
  const safety = intentResult.safety || {};
  const generatedAt = normalize(intentResult.generated_at || nowIso(), 80);

  return intents.map((intent) => intentMemoryFromIntent(intent, { safety, generatedAt })).filter(Boolean);
}

function intentMemoryFromIntent(intent = {}, context = {}) {
  const id = normalize(intent.id || intent.intent_id || intent.label);
  if (!id) return null;
  const evidence = Array.isArray(intent.evidence) ? intent.evidence : [];
  const evidenceIds = unique(evidence.map((item) => item.source_id || item.id || item.packet_id));
  const sources = dedupeSources(evidence.map((item) => ({
    url: item.url,
    domain: item.domain,
    title: item.label || item.title,
    occurred_at: item.timestamp,
    application: item.application,
  })));
  const confidence = clamp(intent.confidence ?? 0);
  const label = normalize(intent.label || id, 180);

  return {
    id: `memory:intent:${slug(id)}`,
    type: "intent_memory",
    label,
    summary: normalize(intent.summary || `Intent hypothesis: ${label}`, 360),
    strength: confidence,
    survival_score: confidence,
    intent_id: id,
    intent_category: normalize(intent.category, 120),
    confidence,
    confidence_level: normalize(intent.confidence_level, 80),
    confidence_basis: intent.confidence_basis || {},
    evidence_ids: evidenceIds,
    evidence,
    alternative_intents: Array.isArray(intent.alternative_intents) ? intent.alternative_intents : [],
    allowed_actions: unique(intent.allowed_actions),
    blocked_actions: unique(intent.blocked_actions),
    notes: unique(intent.notes),
    safety: context.safety || {},
    themes: unique([intent.category, ...(intent.themes || [])]),
    sources,
    reasons: unique([
      intent.confidence_level ? `${intent.confidence_level} confidence intent hypothesis` : "intent hypothesis",
      evidenceIds.length ? `${evidenceIds.length} evidence item${evidenceIds.length === 1 ? "" : "s"}` : "",
    ]),
    first_seen_at: context.generatedAt || nowIso(),
    last_seen_at: context.generatedAt || nowIso(),
    provenance: {
      system: "intent",
      claim_type: "intent_hypothesis",
      schema_version: "memact.intent.v0",
      intent_id: id,
    },
    state: "active",
  };
}

function decayMemory(memory, options = {}) {
  const decayPerDay = Number(options.decayPerDay ?? DEFAULT_DECAY_PER_DAY);
  const ageDays = daysSince(memory.last_seen_at || memory.first_seen_at);
  const decay = Math.min(0.35, ageDays * decayPerDay);
  const decayedStrength = clamp(Number(memory.strength || 0) - decay);

  // Calculate automated TTL expiration trigger thresholds
  let expirationReason = "";
  let state = memory.state || "active";

  if (ageDays >= 30) {
    state = "forgotten";
    expirationReason = `Inactive for ${Math.floor(ageDays)} days`;
  } else if (decayedStrength <= Number(options.retentionThreshold ?? DEFAULT_RETENTION_THRESHOLD)) {
    state = "forgotten";
    expirationReason = `Memory retention strength fallen below threshold (${decayedStrength})`;
  }

  return {
    ...memory,
    state,
    strength: decayedStrength,
    decay: {
      age_days: Number(ageDays.toFixed(2)),
      decay_amount: Number(decay.toFixed(4)),
      decay_per_day: decayPerDay,
      expiration_reason: expirationReason || null
    },
  };
}

function mergeDuplicateMemories(memories) {
  const byKey = new Map();
  for (const memory of memories) {
    const key = isSchemaMemory(memory)
      ? `${memory.type}|${memory.schema_id}`
      : isIntentMemory(memory)
        ? `${memory.type}|${memory.intent_id || memory.label}`
        : `${memory.type}|${memory.source_packet_id || memory.label}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, memory);
      continue;
    }
    byKey.set(key, {
      ...existing,
      strength: clamp(Math.max(existing.strength, memory.strength) + 0.04),
      survival_score: clamp(Math.max(existing.survival_score, memory.survival_score) + 0.04),
      themes: unique([...(existing.themes || []), ...(memory.themes || [])]),
      sources: dedupeSources([...(existing.sources || []), ...(memory.sources || [])]),
      reasons: unique([...(existing.reasons || []), ...(memory.reasons || [])]),
      last_seen_at: [existing.last_seen_at, memory.last_seen_at].sort().filter(Boolean).at(-1) || existing.last_seen_at,
    });
  }
  return [...byKey.values()];
}

function buildMemoryGraph(memories, relations = []) {
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const addNode = (node) => {
    if (!node?.id || seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };

  for (const memory of memories) {
    addNode({
      id: memory.id,
      type: memory.type,
      label: memory.label,
      strength: memory.strength,
      state: memory.state,
    });

    for (const theme of memory.themes || []) {
      const themeId = `memory:theme:${slug(theme)}`;
      addNode({ id: themeId, type: "theme_memory", label: theme });
      edges.push({ from: memory.id, to: themeId, type: "has_theme", weight: memory.strength });
    }

    for (const source of memory.sources || []) {
      const sourceKey = source.url || source.domain || source.title;
      if (!sourceKey) continue;
      const sourceId = `memory:source:${slug(sourceKey)}`;
      addNode({
        id: sourceId,
        type: "source_memory",
        label: source.title || source.domain || source.url,
        url: source.url,
        domain: source.domain,
      });
      edges.push({ from: memory.id, to: sourceId, type: "supported_by_source", weight: 1 });
    }

    if (isSchemaMemory(memory)) {
      const schemaPacketId = memory.schema_packet_id || `schema_packet:${slug(memory.schema_id)}`;
      addNode({
        id: schemaPacketId,
        type: "virtual_cognitive_schema_packet",
        label: memory.label,
        strength: memory.strength,
      });
      edges.push({ from: memory.id, to: schemaPacketId, type: "stores_schema_packet", weight: memory.strength });

      for (const marker of memory.matched_markers || []) {
        const markerId = `memory:schema_marker:${slug(marker)}`;
        addNode({ id: markerId, type: "schema_marker_memory", label: marker });
        edges.push({ from: memory.id, to: markerId, type: "has_cognitive_marker", weight: memory.strength });
      }

      for (const packetId of memory.evidence_packet_ids || []) {
        const activityId = `memory:activity:${slug(packetId)}`;
        edges.push({ from: memory.id, to: activityId, type: "supported_by_packet", weight: memory.strength });
      }
    }

    if (isIntentMemory(memory)) {
      const intentNodeId = memory.intent_id || `intent:${slug(memory.label)}`;
      addNode({
        id: intentNodeId,
        type: "intent_hypothesis",
        label: memory.label,
        confidence: memory.confidence,
      });
      edges.push({ from: memory.id, to: intentNodeId, type: "stores_intent_hypothesis", weight: memory.strength });

      for (const evidenceId of memory.evidence_ids || []) {
        edges.push({
          from: memory.id,
          to: evidenceId,
          type: MEMORY_RELATION_TYPES.EVIDENCED_BY,
          weight: memory.strength,
        });
      }
    }
  }

  for (const rawRelation of Array.isArray(relations) ? relations : []) {
    const relation = normalizeRelationInput(rawRelation);
    if (!relation.from || !relation.to) continue;
    edges.push({
      id: relation.id,
      from: relation.from,
      to: relation.to,
      type: relation.type,
      category: relation.category,
      weight: relation.weight,
      confidence: relation.confidence,
      directed: relation.directed,
      valid_from: relation.valid_from,
      valid_until: relation.valid_until,
      recorded_at: relation.recorded_at,
      invalidated_by: relation.invalidated_by,
      evidence: relation.evidence,
    });
  }

  return { nodes, edges };
}

function makeAction(type, memoryId, payload = {}, accepted = true, reason = "") {
  return {
    id: `action:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    type,
    memory_id: memoryId,
    accepted,
    reason: normalize(reason),
    payload,
    occurred_at: nowIso(),
  };
}

function emptyMemoryStore(previous = {}) {
  const memories = Array.isArray(previous.memories) ? previous.memories : [];
  const relations = Array.isArray(previous.relations) ? previous.relations : [];
  return refreshMemoryStore({
    schema_version: previous.schema_version || MEMORY_SCHEMA_VERSION,
    generated_at: previous.generated_at || nowIso(),
    source: previous.source || {},
    thresholds: previous.thresholds || {},
    memories,
    relations,
    actions: Array.isArray(previous.actions) ? previous.actions : [],
  });
}

/**
 * Computes aggregate stats for a memory store. Shared by reindexMemoryStore,
 * buildMemoryStore, and applyMemoryAction to avoid duplicated filter passes.
 * @param {Array} memories
 * @param {Object} graph
 * @returns {Object}
 */
function computeStoreStats(memories = [], graph = { nodes: [] }) {
  return {
    memoryCount: memories.length,
    activityMemoryCount: memories.filter((memory) => memory.type === "activity_memory").length,
    intentMemoryCount: memories.filter(isIntentMemory).length,
    schemaMemoryCount: memories.filter(isSchemaMemory).length,
    sourceCount: graph.nodes ? graph.nodes.filter((node) => node.type === "source_memory").length : 0,
  };
}

export function reindexMemoryStore(memoryStore = {}) {
  const memories = Array.isArray(memoryStore.memories) ? memoryStore.memories : [];
  const relations = (Array.isArray(memoryStore.relations) ? memoryStore.relations : []).map(normalizeRelationInput);
  const graph = buildMemoryGraph(memories, relations);
  return {
    schema_version: memoryStore.schema_version || MEMORY_SCHEMA_VERSION,
    generated_at: memoryStore.generated_at || nowIso(),
    source: memoryStore.source || {},
    thresholds: memoryStore.thresholds || {},
    memories,
    relations,
    activity_memories: memories.filter((memory) => memory.type === "activity_memory"),
    intent_memories: memories.filter(isIntentMemory),
    schema_packets: memories.filter(isSchemaMemory),
    cognitive_schema_memories: memories.filter(isSchemaMemory),
    graph,
    actions: Array.isArray(memoryStore.actions) ? memoryStore.actions : [],
    graph_snapshots: Array.isArray(memoryStore.graph_snapshots) ? memoryStore.graph_snapshots : [],
    stats: computeStoreStats(memories, graph),
  };
}

function refreshMemoryStore(memoryStore = {}) {
  return reindexMemoryStore({ ...memoryStore, generated_at: nowIso() });
}

function normalizeMemoryInput(input = {}) {
  const id = normalize(input.id) || `memory:manual:${slug(input.label || input.summary || Date.now())}`;
  const type = normalize(input.type) || "activity_memory";
  const strength = clamp(input.strength ?? input.survival_score ?? DEFAULT_RETENTION_THRESHOLD);
  const fieldPath = normalize(input.field_path || input.path || input.attributes?.field_path, 180);
  const category = normalize(input.category || input.attributes?.category || input.provenance?.category, 120);
  const status = normalize(input.status || input.state || "active", 80);
  const sensitivity = normalize(input.sensitivity || input.attributes?.sensitivity || "normal", 80).toLowerCase();
  return {
    id,
    type,
    label: normalize(input.label || id, 180),
    summary: normalize(input.summary, 500),
    field_path: fieldPath,
    category,
    status,
    sensitivity,
    source_app_id: normalize(input.source_app_id || input.provenance?.app_id || input.provenance?.source_app_id, 160),
    allowed_app_ids: Array.isArray(input.allowed_app_ids) ? unique(input.allowed_app_ids) : [],
    allowed_actor_types: Array.isArray(input.allowed_actor_types) ? unique(input.allowed_actor_types) : ["memact_worker"],
    virtual: Boolean(input.virtual),
    cognitive_schema: Boolean(input.cognitive_schema || type === "cognitive_schema_memory"),
    strength,
    survival_score: clamp(input.survival_score ?? strength),
    themes: unique(input.themes),
    sources: dedupeSources(input.sources),
    reasons: unique(input.reasons),
    first_seen_at: normalize(input.first_seen_at || input.created_at || nowIso()),
    last_seen_at: normalize(input.last_seen_at || input.updated_at || nowIso()),
    state: normalize(input.state) || "active",
    provenance: {
      system: normalize(input.provenance?.system || "memory"),
      claim_type: normalize(input.provenance?.claim_type || "manual_memory"),
      ...input.provenance,
    },
    ...input,
    id,
    type,
    field_path: fieldPath,
    category,
    status,
    sensitivity,
  };
}

export function buildMemoryStore({ inference, schema, intent, previousMemory = null, options = {} } = {}) {
  // Clear the query cache since the store state is shifting
  clearQueryCache();
  const activityMemories = (Array.isArray(inference?.records) ? inference.records : [])
    .map((record) => activityMemoryFromRecord(record, options))
    .filter(Boolean);
  const schemaPackets = (Array.isArray(schema?.schemas) ? schema.schemas : [])
    .map(schemaMemoryFromSchema)
    .filter(Boolean);
  const intentMemories = intentMemoriesFromResult(intent);
  const previousMemories = Array.isArray(previousMemory?.memories) ? previousMemory.memories : [];
  const previousRelations = Array.isArray(previousMemory?.relations) ? previousMemory.relations : [];
  const merged = mergeDuplicateMemories([...previousMemories, ...activityMemories, ...schemaPackets, ...intentMemories])
    .map((memory) => decayMemory(memory, options))
    .sort((left, right) => right.strength - left.strength || left.label.localeCompare(right.label));
  const relations = previousRelations.map(normalizeRelationInput);
  const graph = buildMemoryGraph(merged, relations);

  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    generated_at: nowIso(),
    source: {
      inference_schema_version: inference?.schema_version || null,
      schema_schema_version: schema?.schema_version || null,
      intent_schema_version: intent?.schema_version || null,
      previous_memory_version: previousMemory?.schema_version || null,
    },
    thresholds: {
      retention_score: Number(options.retentionThreshold ?? DEFAULT_RETENTION_THRESHOLD),
      decay_per_day: Number(options.decayPerDay ?? DEFAULT_DECAY_PER_DAY),
    },
    memories: merged,
    relations,
    activity_memories: merged.filter((memory) => memory.type === "activity_memory"),
    intent_memories: merged.filter(isIntentMemory),
    schema_packets: merged.filter(isSchemaMemory),
    cognitive_schema_memories: merged.filter(isSchemaMemory),
    graph,
    actions: Array.isArray(previousMemory?.actions) ? previousMemory.actions : [],
    stats: computeStoreStats(merged, graph),
  };
}

export function createMemory(memoryInput, memoryStore = {}) {
  const memory = normalizeMemoryInput(memoryInput);
  const existing = (memoryStore.memories || []).some((item) => item.id === memory.id);
  if (existing) {
    return {
      memoryStore: emptyMemoryStore(memoryStore),
      memory: readMemory(memory.id, memoryStore),
      action: makeAction("create_memory", memory.id, {}, false, "memory already exists"),
    };
  }
  const action = makeAction("create_memory", memory.id, { type: memory.type }, true, "memory created");
  const next = refreshMemoryStore({
    ...memoryStore,
    memories: [...(memoryStore.memories || []), memory],
    actions: [...(memoryStore.actions || []), action],
  });
  return { memoryStore: next, memory, action };
}

export function readMemory(memoryId, memoryStore = {}) {
  const id = normalize(memoryId);
  return (memoryStore.memories || []).find((memory) => memory.id === id) || null;
}

export function listMemories(memoryStore = {}, filters = {}) {
  const type = normalize(filters.type);
  const state = normalize(filters.state);
  const includeForgotten = Boolean(filters.includeForgotten);
  return (memoryStore.memories || [])
    .filter((memory) => !type || memory.type === type)
    .filter((memory) => !state || memory.state === state)
    .filter((memory) => includeForgotten || memory.state !== "forgotten")
    .sort((left, right) => Number(right.strength || 0) - Number(left.strength || 0) || left.label.localeCompare(right.label));
}

export function updateMemory(memoryId, patch = {}, memoryStore = {}) {
  const id = normalize(memoryId);
  let updated = null;
  const memories = (memoryStore.memories || []).map((memory) => {
    if (memory.id !== id) return memory;
    updated = normalizeMemoryInput({
      ...memory,
      ...patch,
      id: memory.id,
      type: patch.type || memory.type,
      sources: patch.sources ? dedupeSources([...(memory.sources || []), ...patch.sources]) : memory.sources,
      themes: patch.themes ? unique([...(memory.themes || []), ...patch.themes]) : memory.themes,
      reasons: patch.reasons ? unique([...(memory.reasons || []), ...patch.reasons]) : memory.reasons,
      last_seen_at: patch.last_seen_at || nowIso(),
    });
    return updated;
  });
  const action = makeAction("update_memory", id, { patch_keys: Object.keys(patch || {}) }, Boolean(updated), updated ? "memory updated" : "memory not found");
  const next = refreshMemoryStore({
    ...memoryStore,
    memories,
    actions: [...(memoryStore.actions || []), action],
  });
  return { memoryStore: next, memory: updated, action };
}

export function deleteMemory(memoryId, memoryStore = {}, options = {}) {
  if (options.hard) {
    const id = normalize(memoryId);
    const before = (memoryStore.memories || []).length;
    const memories = (memoryStore.memories || []).filter((memory) => memory.id !== id);
    const relations = (memoryStore.relations || []).filter((relation) => relation.from !== id && relation.to !== id);
    const accepted = memories.length !== before;
    const action = makeAction("delete_memory", id, { hard: true }, accepted, accepted ? "memory deleted" : "memory not found");
    return {
      memoryStore: refreshMemoryStore({
        ...memoryStore,
        memories,
        relations,
        actions: [...(memoryStore.actions || []), action],
      }),
      action,
    };
  }
  return forgetMemory(memoryId, memoryStore);
}

export function retrieveMemories(query, memoryStore, options = {}) {
  if (options.queryEmbedding) {
    validateVectorSearchAccess(options);
  }
  const top = Number(options.top ?? 8);
  const minScore = Number(options.minScore ?? 0.12);
  const memories = Array.isArray(memoryStore?.memories) ? memoryStore.memories : [];

  // Track client configuration context for audit verification
  const clientId = normalize(options.clientId || options.appId || "unknown_client");
  const queriedPath = normalize(options.fieldPath || options.path || "generic_query");

  // Extract audit parameters if provided in options
  const auditContext = options.auditContext; // e.g., { currentCategory: 'urgency_cue', capabilities: [] }

  const results = memories
    .map((memory) => {
      const lexical = overlapScore(query, memory);
      let searchScore = lexical;
      if (options.queryEmbedding && Array.isArray(memory.embedding)) {
        const semantic = cosineSimilarity(options.queryEmbedding, memory.embedding);
        const alpha = Number(options.alpha ?? 0.5);
        searchScore = (lexical * (1 - alpha)) + (semantic * alpha);
      }
      const score = clamp((searchScore * 0.56) + (Number(memory.strength || 0) * 0.34) + (isSchemaMemory(memory) ? 0.1 : 0));

      const BaseResult = {
        ...memory,
        retrieval_score: score,
        retrieval_reason: lexical || (options.queryEmbedding && Array.isArray(memory.embedding))
          ? "query overlap or semantic match with retained memory"
          : "high-strength retained memory",
      };

      // If an audit context is supplied, evaluate leakage across the query text and memory content
      if (auditContext) {
        const textToAudit = `${query} ${memory.label} ${memory.summary}`;
        const audit = auditContextLeakage(auditContext, textToAudit);

        BaseResult.audit = {
          leaked: audit.leaked,
          violations: audit.violations
        };
      }

      return BaseResult;
    })
    .filter((memory) => memory.retrieval_score >= minScore)
    // Optional: You can filter out leaked items entirely if required, 
    // or just pass them through with the audit flag attached for the worker to handle.
    .sort((left, right) => right.retrieval_score - left.retrieval_score || right.strength - left.strength)
    .slice(0, top);

  results.auditTrailLog = {
    id: `audit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    client_id: clientId,
    queried_path: queriedPath,
    result_count: results.length,
    timestamp: new Date().toISOString(),
  };
  return results;
}

export function retrieveCognitiveSchemas(query, memoryStore, options = {}) {
  return retrieveMemories(query, {
    ...memoryStore,
    memories: (memoryStore?.memories || []).filter(isSchemaMemory),
  }, {
    top: Number(options.top ?? 4),
    minScore: Number(options.minScore ?? 0.12),
  });
}

export function buildRagContext(query, memoryStore = {}, options = {}) {
  const top = Number(options.top ?? DEFAULT_RAG_TOP);
  const cognitiveSchemas = retrieveCognitiveSchemas(query, memoryStore, {
    top: Number(options.schemaTop ?? Math.min(4, top)),
    minScore: Number(options.schemaMinScore ?? 0.08),
  });
  const supportingMemories = retrieveMemories(query, memoryStore, {
    top,
    minScore: Number(options.minScore ?? 0.08),
  }).filter((memory) => !cognitiveSchemas.some((schema) => schema.id === memory.id));
  const sourceMap = new Map();
  [...cognitiveSchemas, ...supportingMemories].forEach((memory) => {
    (memory.sources || []).forEach((source) => {
      const key = source.url || `${source.domain}|${source.title}`;
      if (key && !sourceMap.has(key)) sourceMap.set(key, source);
    });
  });
  const contextItems = [...cognitiveSchemas, ...supportingMemories].slice(0, top).map((memory, index) => ({
    rank: index + 1,
    id: memory.id,
    type: memory.type,
    label: memory.label,
    summary: memory.summary,
    strength: Number(memory.strength || 0),
    retrieval_score: Number(memory.retrieval_score || 0),
    core_interpretation: memory.core_interpretation || "",
    action_tendency: memory.action_tendency || "",
    themes: memory.themes || [],
    evidence_packet_ids: memory.evidence_packet_ids || [],
    source_count: (memory.sources || []).length,
  }));
  const contextIds = new Set(contextItems.map((item) => item.id));
  const relationTrails = (memoryStore.relations || [])
    .map(normalizeRelationInput)
    .filter((relation) => contextIds.has(relation.from) || contextIds.has(relation.to))
    .sort((left, right) => right.weight - left.weight || right.confidence - left.confidence)
    .slice(0, 12);
  const memoryLanes = buildMemoryLanes(contextItems, relationTrails);

  return {
    contract: "memact.rag_context",
    version: "0.1.0",
    generated_at: nowIso(),
    query: normalize(query, 240),
    policy: {
      retrieval_first: true,
      prefer_cognitive_schema_memory: true,
      use_sources_as_evidence: true,
      no_diagnosis: true,
      no_causal_certainty: true,
      cloud_payload_minimized: true,
    },
    retrieval_steps: [
      "retrieve matching cognitive schema memories",
      "attach supporting activity memories",
      "attach memory relation trails",
      "attach source evidence",
    ],
    memory_lanes: memoryLanes,
    relation_trails: relationTrails,
    cognitive_schema_memories: cognitiveSchemas,
    supporting_memories: supportingMemories.slice(0, Math.max(0, top - cognitiveSchemas.length)),
    context_items: contextItems,
    sources: [...sourceMap.values()].slice(0, MAX_SOURCES),
    stats: {
      cognitive_schema_count: cognitiveSchemas.length,
      supporting_memory_count: supportingMemories.length,
      relation_trail_count: relationTrails.length,
      source_count: sourceMap.size,
    },
  };
}

function buildMemoryLanes(contextItems = [], relationTrails = []) {
  const lanes = {
    cognitive_schema: [],
    activity: [],
    evidence_source: [],
    relation: [],
  };
  for (const item of contextItems) {
    const lane = item.type === "cognitive_schema_memory" || item.type === "schema_memory" ? "cognitive_schema" : "activity";
    lanes[lane].push({
      id: item.id,
      label: item.label,
      strength: item.strength,
      retrieval_score: item.retrieval_score,
    });
  }
  for (const relation of relationTrails) {
    lanes.relation.push({
      id: relation.id,
      type: relation.type,
      from: relation.from,
      to: relation.to,
      weight: relation.weight,
    });
  }
  return lanes;
}

export function rememberPacket(packet, memoryStore = {}, options = {}) {
  const memory = activityMemoryFromRecord(packet, options);
  if (!memory) {
    return {
      memoryStore,
      action: makeAction("remember_packet", "", { packet_id: packet?.packet_id || packet?.id }, false, "packet did not pass retention threshold"),
    };
  }
  const next = buildMemoryStore({
    inference: { records: [packet], schema_version: "memact.inference.v0" },
    schema: { schemas: [], schema_version: "memact.schema.v0" },
    previousMemory: memoryStore,
    options,
  });
  const action = makeAction("remember_packet", memory.id, { packet_id: memory.source_packet_id }, true, "packet retained");
  next.actions = [...(next.actions || []), action];
  return { memoryStore: next, action };
}

export function rememberInferenceRecord(record, memoryStore = {}, options = {}) {
  return rememberPacket(record, memoryStore, options)
}

export function rememberSchemaPacket(packet, memoryStore = {}) {
  if (packet?.schema_type === "reading_preferences" || packet?.category === "reading") {
    const attributes = packet.attributes && typeof packet.attributes === "object" ? packet.attributes : {}
    return createMemory({
      id: `memory:reading:${slug(packet.packet_id || packet.id || "reading_preferences")}`,
      type: "reading_preference_memory",
      label: "Reading preferences",
      summary: summarizeReadingPreferences(attributes),
      strength: clamp(packet.confidence ?? 0.62),
      confidence: clamp(packet.confidence ?? 0.62),
      category: "reading",
      schema_id: "reading_preferences",
      schema_packet_id: normalize(packet.packet_id || packet.id),
      schema_refs: ["reading_preferences"],
      evidence_refs: unique((packet.sources || []).map((source) => source.id || source.source_id || source.url || source.title)),
      feature_refs: ["adaptive-article-overview"],
      attributes,
      themes: unique(["reading", ...(attributes.preferred_topics || []), ...(attributes.repeat_topics || [])]),
      sources: packet.sources || [],
      reasons: ["reading preference schema retained"],
      provenance: { system: "schema", claim_type: "reading_preference_memory" },
      state: "active"
    }, memoryStore)
  }
  return rememberSchema(packet, memoryStore)
}

export function rememberFeatureOutput(output = {}, memoryStore = {}) {
  const featureId = normalize(output.feature_id || output.featureId || "feature", 120)
  const memory = normalizeMemoryInput({
    id: `memory:feature:${slug(`${featureId}_${Date.now()}`)}`,
    type: "feature_output_memory",
    label: normalize(output.name || featureId, 160),
    summary: normalize(output.summary || JSON.stringify(output.output || {}).slice(0, 300), 360),
    strength: clamp(output.confidence ?? 0.6),
    feature_id: featureId,
    feature_refs: [featureId],
    provenance: { system: "playground", claim_type: "feature_output" },
    state: "active",
  })
  return createMemory(memory, memoryStore)
}

export function listMemoryRecords(filter = {}, memoryStore = {}) {
  return (memoryStore.memories || []).filter((memory) => {
    if (filter.type && memory.type !== filter.type) return false
    if (filter.state && memory.state !== filter.state) return false
    return true
  })
}

export function retrieveContext(query, memoryStore = {}, options = {}) {
  return buildRagContext(query, memoryStore, options)
}

export function retrieveSchemaPackets(filter = {}, memoryStore = {}) {
  return listMemoryRecords({ ...filter, type: filter.type || "cognitive_schema_memory" }, memoryStore)
}

export function createCorrection(memoryId, correction = {}, memoryStore = {}) {
  const action = makeAction("correction_record", memoryId, correction, true, "user correction recorded")
  return applyMemoryAction(memoryStore, action, (memory) => ({
    ...memory,
    corrections: [...(memory.corrections || []), { ...correction, created_at: nowIso() }],
    strength: clamp(Number(memory.strength || 0) + 0.02),
  }))
}

export function buildContextForFeature(featureId, memoryStore = {}, options = {}) {
  if (featureId === "adaptive-article-overview") {
    return {
      feature_id: featureId,
      reading_memory: buildReadingMemorySummary(memoryStore),
      context: retrieveContext(options.query || "reading preferences", memoryStore, options),
      schema_packets: retrieveSchemaPackets({ category: "reading" }, memoryStore),
    }
  }
  return {
    feature_id: normalize(featureId),
    context: retrieveContext(options.query || featureId, memoryStore, options),
    schema_packets: retrieveSchemaPackets({}, memoryStore),
  }
}

function summarizeReadingPreferences(attributes = {}) {
  const parts = []
  if (attributes.preferred_topics?.length) parts.push(`preferred topics: ${attributes.preferred_topics.join(", ")}`)
  if (attributes.skipped_topics?.length) parts.push(`skipped topics: ${attributes.skipped_topics.join(", ")}`)
  if (attributes.preferred_summary_style && attributes.preferred_summary_style !== "unknown") parts.push(`summary style: ${attributes.preferred_summary_style}`)
  if (attributes.preferred_article_length && attributes.preferred_article_length !== "unknown") parts.push(`article length: ${attributes.preferred_article_length}`)
  return parts.length ? parts.join("; ") : "Reading preference memory from approved article activity."
}

function buildReadingMemorySummary(memoryStore = {}) {
  const memories = (memoryStore.memories || []).filter((memory) => memory.type === "reading_preference_memory")
  const attributes = Object.assign({}, ...memories.map((memory) => memory.attributes || {}))
  return {
    average_read_time_seconds: Number(attributes.average_read_time_seconds || 0),
    average_scroll_depth: Number(attributes.average_scroll_depth || 0),
    finish_rate: Number(attributes.finish_rate || 0),
    preferred_topics: unique(attributes.preferred_topics || []),
    skipped_topics: unique(attributes.skipped_topics || []),
    preferred_article_length: normalize(attributes.preferred_article_length || "unknown"),
    preferred_summary_style: normalize(attributes.preferred_summary_style || "unknown"),
    repeat_topics: unique(attributes.repeat_topics || [])
  }
}

export function rememberSchema(schemaPacket, memoryStore = {}) {
  const memory = schemaMemoryFromSchema(schemaPacket);
  if (!memory) {
    return {
      memoryStore,
      action: makeAction("remember_schema", "", { schema_id: schemaPacket?.id }, false, "schema packet missing id"),
    };
  }
  const next = buildMemoryStore({
    inference: { records: [], schema_version: "memact.inference.v0" },
    schema: { schemas: [schemaPacket], schema_version: "memact.schema.v0" },
    previousMemory: memoryStore,
  });
  const action = makeAction("remember_schema", memory.id, { schema_id: memory.schema_id }, true, "schema retained");
  next.actions = [...(next.actions || []), action];
  return { memoryStore: next, action };
}

export function rememberIntent(intentResult, memoryStore = {}) {
  const memories = intentMemoriesFromResult(intentResult);
  if (!memories.length) {
    return {
      memoryStore,
      action: makeAction("remember_intent", "", {}, false, "intent result did not include predicted intents"),
    };
  }
  const next = buildMemoryStore({
    inference: { records: [], schema_version: "memact.inference.v0" },
    schema: { schemas: [], schema_version: "memact.schema.v0" },
    intent: intentResult,
    previousMemory: memoryStore,
  });
  const action = makeAction("remember_intent", memories[0].id, { intent_count: memories.length }, true, "intent retained");
  next.actions = [...(next.actions || []), action];
  return { memoryStore: next, memories, action };
}

export function retrieveIntents(query, memoryStore = {}, options = {}) {
  return retrieveMemories(query, {
    ...memoryStore,
    memories: (memoryStore?.memories || []).filter(isIntentMemory),
  }, {
    top: Number(options.top ?? 4),
    minScore: Number(options.minScore ?? 0.08),
  });
}

export function linkIntentToSchema(intentId, schemaId, memoryStore = {}) {
  return relateMemories(intentId, schemaId, MEMORY_RELATION_TYPES.BUILDS_ON, {
    reason: "intent hypothesis used schema context",
  }, memoryStore);
}

export function linkIntentToEvidence(intentId, evidenceId, memoryStore = {}) {
  return addRelation(memoryStore, {
    from: intentId,
    to: evidenceId,
    type: MEMORY_RELATION_TYPES.EVIDENCED_BY,
    evidence: { reason: "intent hypothesis cites approved evidence" },
  }, makeAction("link_intent_to_evidence", intentId, { evidence_id: normalize(evidenceId) }, true, "intent linked to evidence"));
}

export function reinforceMemory(memoryId, evidence = {}, memoryStore = {}) {
  const action = makeAction("reinforce_memory", memoryId, evidence, true, "memory reinforced by evidence");
  const result = applyMemoryAction(memoryStore, action, (memory) => ({
    ...memory,
    strength: clamp(Number(memory.strength || 0) + 0.08),
    survival_score: clamp(Number(memory.survival_score || 0) + 0.08),
    sources: dedupeSources([...(memory.sources || []), ...(evidence.sources || [])]),
  }));
  if (!result.action.accepted) return result;
  return addRelation(result.memoryStore, {
    from: memoryId,
    to: evidence.memory_id || evidence.source_memory_id || memoryId,
    type: MEMORY_RELATION_TYPES.REINFORCES,
    evidence,
  }, action);
}

export function weakenMemory(memoryId, reason = "", memoryStore = {}) {
  const action = makeAction("weaken_memory", memoryId, { reason: normalize(reason) }, true, "memory weakened");
  return applyMemoryAction(memoryStore, action, (memory) => ({
    ...memory,
    strength: clamp(Number(memory.strength || 0) - 0.12),
    state: Number(memory.strength || 0) <= 0.16 ? "weak" : memory.state,
  }));
}

export function forgetMemory(memoryId, memoryStore = {}) {
  const action = makeAction("forget_memory", memoryId, {}, true, "memory forgotten");
  return applyMemoryAction(memoryStore, action, (memory) => ({
    ...memory,
    strength: 0,
    state: "forgotten",
  }));
}

export function linkMemories(fromId, toId, memoryStore = {}, relation = "related") {
  return relateMemories(fromId, toId, relation, {}, memoryStore).memoryStore;
}

export function relateMemories(fromId, toId, relation = MEMORY_RELATION_TYPES.RELATED, evidence = {}, memoryStore = {}) {
  const from = normalize(fromId);
  const to = normalize(toId);
  const type = normalizeRelationType(relation);
  const memories = memoryStore.memories || [];
  const exists = memories.some((memory) => memory.id === from) && memories.some((memory) => memory.id === to);
  const action = makeAction("relate_memories", from, { to, relation: type }, exists, exists ? "memories related" : "both memories must exist before linking");
  if (!exists) return { memoryStore: emptyMemoryStore(memoryStore), relation: null, action };
  return addRelation(memoryStore, { from, to, type, evidence }, action);
}

export function assimilateEvidence(memoryId, evidence = {}, memoryStore = {}) {
  const packetIds = unique(evidence.packet_ids || evidence.evidence_packet_ids || (evidence.packet_id ? [evidence.packet_id] : []));
  const action = makeAction("assimilate_evidence", memoryId, {
    packet_ids: packetIds,
    source_count: Array.isArray(evidence.sources) ? evidence.sources.length : 0,
  }, true, "evidence assimilated into memory");
  const result = applyMemoryAction(memoryStore, action, (memory) => ({
    ...memory,
    strength: clamp(Number(memory.strength || 0) + 0.06 + Math.min(0.08, packetIds.length * 0.015)),
    survival_score: clamp(Number(memory.survival_score || 0) + 0.05),
    support: Number(memory.support || 0) + Math.max(1, packetIds.length),
    evidence_packet_ids: unique([...(memory.evidence_packet_ids || []), ...packetIds]),
    sources: dedupeSources([...(memory.sources || []), ...(evidence.sources || [])]),
    themes: unique([...(memory.themes || []), ...(evidence.themes || [])]),
    reasons: unique([...(memory.reasons || []), normalize(evidence.reason || "new evidence matched this schema")]),
    last_seen_at: normalize(evidence.occurred_at || nowIso(), 80),
    schema_state: memory.schema_state || "assimilating",
  }));
  if (!result.action.accepted) return result;
  return addRelation(result.memoryStore, {
    from: memoryId,
    to: evidence.source_memory_id || memoryId,
    type: MEMORY_RELATION_TYPES.ASSIMILATES,
    evidence: { ...evidence, packet_ids: packetIds },
  }, action);
}

export function accommodateSchema(memoryInput, evidence = {}, memoryStore = {}) {
  const schemaMemory = normalizeMemoryInput({
    ...memoryInput,
    type: "cognitive_schema_memory",
    virtual: true,
    cognitive_schema: true,
    state: memoryInput.state || "active",
    schema_state: memoryInput.schema_state || "accommodated",
    provenance: {
      system: "memory",
      claim_type: "accommodated_cognitive_schema",
      ...(memoryInput.provenance || {}),
    },
    evidence_packet_ids: unique(memoryInput.evidence_packet_ids || evidence.packet_ids || evidence.evidence_packet_ids),
    sources: dedupeSources([...(memoryInput.sources || []), ...(evidence.sources || [])]),
    reasons: unique([...(memoryInput.reasons || []), evidence.reason || "new evidence needed a separate schema"]),
  });
  const created = createMemory(schemaMemory, memoryStore);
  if (!created.action.accepted) return created;
  const action = makeAction("accommodate_schema", schemaMemory.id, { reason: normalize(evidence.reason, 240) }, true, "new schema accommodated");
  const next = refreshMemoryStore({
    ...created.memoryStore,
    actions: [...(created.memoryStore.actions || []), action],
  });
  return addRelation(next, {
    from: schemaMemory.id,
    to: evidence.source_memory_id || schemaMemory.id,
    type: MEMORY_RELATION_TYPES.ACCOMMODATES,
    evidence,
  }, action);
}

export function supersedeMemory(memoryId, replacementInput = {}, reason = "", memoryStore = {}) {
  const previous = readMemory(memoryId, memoryStore);
  if (!previous) {
    const action = makeAction("supersede_memory", memoryId, {}, false, "memory not found");
    return { memoryStore: emptyMemoryStore(memoryStore), memory: null, replaced: null, action };
  }
  const replacement = normalizeMemoryInput({
    ...previous,
    ...replacementInput,
    id: replacementInput.id || `${previous.id}:v${Date.now()}`,
    supersedes: unique([...(replacementInput.supersedes || []), previous.id]),
    reasons: unique([...(previous.reasons || []), ...(replacementInput.reasons || []), reason || "memory updated by newer evidence"]),
    strength: clamp(Math.max(previous.strength || 0, replacementInput.strength ?? previous.strength ?? 0) + 0.04),
    first_seen_at: replacementInput.first_seen_at || previous.first_seen_at,
    last_seen_at: replacementInput.last_seen_at || nowIso(),
    state: replacementInput.state || "active",
  });
  const memories = (memoryStore.memories || []).map((memory) => (
    memory.id === previous.id
      ? {
        ...memory,
        state: "superseded",
        superseded_by: replacement.id,
        valid_until: nowIso(),
        strength: clamp(Number(memory.strength || 0) - 0.18),
      }
      : memory
  ));
  const action = makeAction("supersede_memory", previous.id, { replacement_id: replacement.id, reason: normalize(reason) }, true, "memory superseded");
  const next = refreshMemoryStore({
    ...memoryStore,
    memories: [...memories, replacement],
    actions: [...(memoryStore.actions || []), action],
  });
  const withForward = addRelation(next, {
    from: replacement.id,
    to: previous.id,
    type: MEMORY_RELATION_TYPES.SUPERSEDES,
    evidence: { reason },
  }, action);
  const withReverse = addRelation(withForward.memoryStore, {
    from: previous.id,
    to: replacement.id,
    type: MEMORY_RELATION_TYPES.SUPERSEDED_BY,
    evidence: { reason },
  }, action);
  return {
    memoryStore: withReverse.memoryStore,
    memory: replacement,
    replaced: previous,
    action,
  };
}

export function getMemoryTimeline(memoryStore = {}, options = {}) {
  const limit = Number(options.limit ?? 50);
  const memoryEvents = (memoryStore.memories || []).flatMap((memory) => [
    memory.first_seen_at ? { type: "first_seen", memory_id: memory.id, label: memory.label, occurred_at: memory.first_seen_at } : null,
    memory.last_seen_at ? { type: "last_seen", memory_id: memory.id, label: memory.label, occurred_at: memory.last_seen_at } : null,
  ]).filter(Boolean);
  const actionEvents = (memoryStore.actions || []).map((action) => ({
    type: action.type,
    memory_id: action.memory_id,
    label: action.reason,
    occurred_at: action.occurred_at,
    accepted: action.accepted,
  }));
  const relationEvents = (memoryStore.relations || []).map((relation) => ({
    type: `relation:${relation.type}`,
    memory_id: relation.from,
    target_id: relation.to,
    label: relation.evidence?.reason || relation.type,
    occurred_at: relation.recorded_at || relation.valid_from,
  }));
  return [...memoryEvents, ...actionEvents, ...relationEvents]
    .sort((left, right) => parseTime(right.occurred_at) - parseTime(left.occurred_at))
    .slice(0, limit);
}

export function queryMemoryGraph(query, memoryStore = {}, options = {}) {
  const top = Number(options.top ?? 6);
  const retrieved = retrieveMemories(query, memoryStore, { top, minScore: options.minScore ?? 0.08 });
  const ids = new Set(retrieved.map((memory) => memory.id));
  const relationTrails = (memoryStore.relations || [])
    .map(normalizeRelationInput)
    .filter((relation) => ids.has(relation.from) || ids.has(relation.to))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, Number(options.relationTop ?? 12));
  return {
    query: normalize(query, 240),
    memories: retrieved,
    relation_trails: relationTrails,
    timeline: getMemoryTimeline(memoryStore, { limit: Number(options.timelineLimit ?? 12) }),
  };
}

function addRelation(memoryStore = {}, relationInput = {}, action = null) {
  const relation = normalizeRelationInput(relationInput);
  if (!relation.from || !relation.to) {
    const rejected = action ? { ...action, accepted: false, reason: "relation missing endpoints" } : makeAction("relate_memories", relation.from, relation, false, "relation missing endpoints");
    return { memoryStore: emptyMemoryStore(memoryStore), relation: null, action: rejected };
  }
  const relations = [...(memoryStore.relations || []).filter((item) => item.id !== relation.id), relation];
  const next = refreshMemoryStore({
    ...memoryStore,
    relations,
    actions: action && !(memoryStore.actions || []).some((item) => item.id === action.id)
      ? [...(memoryStore.actions || []), action]
      : (memoryStore.actions || []),
  });
  return { memoryStore: next, relation, action: action || makeAction("relate_memories", relation.from, relation, true, "memories related") };
}

export function explainMemory(memoryId, memoryStore = {}) {
  const memory = (memoryStore.memories || []).find((item) => item.id === memoryId);
  if (!memory) {
    return null;
  }
  return {
    id: memory.id,
    type: memory.type,
    label: memory.label,
    summary: memory.summary,
    strength: memory.strength,
    themes: memory.themes || [],
    sources: memory.sources || [],
    provenance: memory.provenance,
    explanation: `${memory.label} survived because ${formatReasons(memory)}.`,
  };
}

export function getMemoryGraph(memoryStore = {}) {
  return memoryStore.graph || buildMemoryGraph(memoryStore.memories || []);
}

export function formatMemoryReport(memoryStore = {}) {
  const lines = [
    "Memact Memory Report",
    `Memories: ${memoryStore.stats?.memoryCount || 0}`,
    `Activity memories: ${memoryStore.stats?.activityMemoryCount || 0}`,
    `Cognitive schema memories: ${memoryStore.stats?.schemaMemoryCount || 0}`,
    `Intent memories: ${memoryStore.stats?.intentMemoryCount || 0}`,
    "",
    "Strongest Memories",
  ];

  const memories = Array.isArray(memoryStore.memories) ? memoryStore.memories : [];
  if (!memories.length) {
    lines.push("No memories met the survival threshold.");
    return lines.join("\n");
  }

  memories.slice(0, 10).forEach((memory, index) => {
    lines.push(`${index + 1}. ${memory.label}`);
    lines.push(`   type=${memory.type} strength=${Number(memory.strength || 0).toFixed(3)} themes=${(memory.themes || []).join(", ") || "none"}`);
    lines.push(`   why=${formatReasons(memory)}`);
  });

  return lines.join("\n");
}

function applyMemoryAction(memoryStore, action, mutate) {
  let matched = false;
  const memories = (memoryStore.memories || []).map((memory) => {
    if (memory.id !== action.memory_id) return memory;
    matched = true;
    return mutate(memory);
  });
  const finalAction = matched ? action : { ...action, accepted: false, reason: "memory not found" };
  const nextGraph = buildMemoryGraph(memories, memoryStore.relations || []);
  const next = {
    ...memoryStore,
    memories,
    activity_memories: memories.filter((memory) => memory.type === "activity_memory"),
    intent_memories: memories.filter(isIntentMemory),
    schema_packets: memories.filter(isSchemaMemory),
    cognitive_schema_memories: memories.filter(isSchemaMemory),
    graph: nextGraph,
    relations: memoryStore.relations || [],
    actions: [...(memoryStore.actions || []), finalAction],
    stats: computeStoreStats(memories, nextGraph),
  };
  return { memoryStore: next, action: finalAction };
}

function formatReasons(memory) {
  const reasons = unique([
    ...(memory.reasons || []),
    isSchemaMemory(memory) && memory.core_interpretation ? `frame: ${memory.core_interpretation}` : "",
    isSchemaMemory(memory) ? `${memory.support || 0} supporting packets` : "",
    isIntentMemory(memory) && memory.confidence_level ? `intent confidence: ${memory.confidence_level}` : "",
    memory.sources?.length ? `${memory.sources.length} source${memory.sources.length === 1 ? "" : "s"}` : "",
  ]);
  return reasons.length ? reasons.join(", ") : "it has retained evidence";
}

function isSchemaMemory(memory) {
  return memory?.type === "cognitive_schema_memory" || memory?.type === "schema_memory";
}

function isIntentMemory(memory) {
  return memory?.type === "intent_memory";
}
// Stores historical genre weights to maintain a running baseline profile
let USER_MEDIA_BASELINE = new Map();
const BASELINE_DECAY = 0.95; // Keeps baseline adaptable but stable
const ANOMALY_THRESHOLD = 0.70; // Sensitivity limit for structural signature shifts

/**
 * Updates the user's core media baseline with normal playback patterns.
 * @param {Array<string>} genres 
 */
export function trainMediaBaseline(genres = []) {
  // Decay old weights to let the baseline adapt smoothly over time
  for (const [genre, weight] of USER_MEDIA_BASELINE.entries()) {
    USER_MEDIA_BASELINE.set(genre, weight * BASELINE_DECAY);
  }
  // Add new signals
  genres.forEach(genre => {
    const normalized = genre.toLowerCase().trim();
    USER_MEDIA_BASELINE.set(normalized, (USER_MEDIA_BASELINE.get(normalized) || 0) + 1.0);
  });
}

/**
 * Detects structural changes in playback content streams and returns 
 * the target isolation partition ('shared-session' or 'default').
 * * @param {Object} playbackEvent - { title, artist, genres: ['pop', 'rock'] }
 * @returns {string} Target memory partition assignment
 */
export function detectSessionAnomaly(playbackEvent = {}) {
  const incomingGenres = playbackEvent.genres || [];
  if (incomingGenres.length === 0 || USER_MEDIA_BASELINE.size === 0) {
    return "default"; // Default path if no baseline or incoming tracking metrics exist
  }

  let matchScore = 0;
  let totalIncomingWeight = incomingGenres.length;

  // Calculate alignment score against user's established historical tastes
  incomingGenres.forEach(genre => {
    const normalized = genre.toLowerCase().trim();
    if (USER_MEDIA_BASELINE.has(normalized)) {
      // Scale matching score based on how strong that genre is in baseline history
      matchScore += Math.min(USER_MEDIA_BASELINE.get(normalized), 1.0);
    }
  });

  const alignmentRatio = matchScore / totalIncomingWeight;

  // An anomaly is triggered if the similarity falls drastically below our threshold
  if (alignmentRatio < (1 - ANOMALY_THRESHOLD)) {
    return "shared-session"; // Isolate under quarantined partition flag
  }

  return "default";
}

/**
 * Resets the in-memory media baseline profile between test sweeps.
 */
export function clearMediaBaseline() {
  USER_MEDIA_BASELINE.clear();
}

/**
 * Automatically evaluates memory records and filters out any temporary 
 * travel health context or requirements that have passed their self-destruct timestamp.
 * * @param {Array<Object>} records - Array of memory objects to evaluate
 * @returns {Array<Object>} Filtered array containing only non-expired records
 */
export function purgeExpiredRecords(records = []) {
  if (!Array.isArray(records)) return [];

  const currentTime = Date.now();

  return records.filter(record => {
    // Check if the record has an expiration or self-destruct timestamp
    const expirationTime = record.selfDestructAt || record.expiresAt;

    if (expirationTime) {
      // If the current time has reached or passed expiration, drop the record (return false)
      return currentTime < new Date(expirationTime).getTime();
    }

    // Keep records that don't have an expiration attribute
    return true;
  });
}


// Append-only commit log storage array
let COMMIT_JOURNAL_LOG = [];

// Maximum number of entries to retain before triggering rotation truncation
const MAX_LOG_THRESHOLD = 50;

/**
 * Appends an entry to the journal log and automatically truncates old rows
 * if the total length violates our maximum boundary size.
 * * @param {Object|string} entry - The log event metadata or text string to commit
 * @returns {Array<Object|string>} The updated, bounded journal log array
 */
export function appendCommitLog(entry) {
  if (entry === undefined || entry === null) return COMMIT_JOURNAL_LOG;

  // Append new log entry to the end of our journal track
  COMMIT_JOURNAL_LOG.push(entry);

  // If the log exceeds bounds, truncate older rows out of the array
  if (COMMIT_JOURNAL_LOG.length > MAX_LOG_THRESHOLD) {
    COMMIT_JOURNAL_LOG = COMMIT_JOURNAL_LOG.slice(-MAX_LOG_THRESHOLD);
  }

  return COMMIT_JOURNAL_LOG;
}

/**
 * Retrieves the current state of the commit journal log array.
 * @returns {Array<Object|string>}
 */
export function getCommitJournal() {
  return COMMIT_JOURNAL_LOG;
}

/**
 * Resets the journal log state between validation sweeps.
 */
export function clearCommitJournal() {
  COMMIT_JOURNAL_LOG = [];
}