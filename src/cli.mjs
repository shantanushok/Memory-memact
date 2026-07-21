#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildMemoryStore, buildRagContext, formatMemoryReport, retrieveMemories } from "./engine.mjs";
import { createEmbeddingService } from "./embeddings.mjs";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function readJson(path) {
  if (!path) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

const inferencePath = argValue("--inference");
const schemaPath = argValue("--schema");
const previousPath = argValue("--memory");
const query = argValue("--query");
const format = argValue("--format", "report");
const graphLimit = Number(argValue("--limit", "24")) || 24;

const accessToken = argValue("--access-token");
const oauthClientId = argValue("--oauth-client-id");
const oauthClientSecret = argValue("--oauth-client-secret");
const oauthEndpoint = argValue("--oauth-endpoint");
const provider = argValue("--embedding-provider");

if (!inferencePath && !schemaPath) {
  console.error("Usage: memact-memory --inference inference.json --schema schema.json [--memory memory.json] [--query thought] [--format report|json|graph|mermaid|dot]");
  process.exit(1);
}

const memoryStore = buildMemoryStore({
  inference: await readJson(inferencePath),
  schema: await readJson(schemaPath),
  previousMemory: await readJson(previousPath),
});

function safeId(value) {
  return String(value || "node")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^([^a-zA-Z_])/, "_$1");
}

function nodeLabel(node, fallback = "") {
  return String(node?.label || node?.id || fallback || "node").replace(/\s+/g, " ").trim();
}

function formatNodeType(type = "") {
  return String(type || "node").replace(/_/g, " ");
}

function buildGraphSelection(memoryStore, limit = 24) {
  const graph = memoryStore.graph || { nodes: [], edges: [] };
  const schemaIds = new Set((memoryStore.schema_packets || []).map((item) => item.id));
  const selectedIds = new Set();
  for (const id of schemaIds) selectedIds.add(id);
  for (const edge of graph.edges || []) {
    if (schemaIds.has(edge.from) || schemaIds.has(edge.to)) {
      selectedIds.add(edge.from);
      selectedIds.add(edge.to);
    }
    if (selectedIds.size >= limit) break;
  }
  for (const relation of memoryStore.relations || []) {
    if (schemaIds.has(relation.from) || schemaIds.has(relation.to)) {
      selectedIds.add(relation.from);
      selectedIds.add(relation.to);
    }
    if (selectedIds.size >= limit) break;
  }
  const selectedNodes = (graph.nodes || [])
    .filter((node) => selectedIds.has(node.id))
    .slice(0, limit);
  const nodeIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = [
    ...(graph.edges || []).map((edge) => ({ ...edge, relation: edge.type })),
    ...(memoryStore.relations || []).map((relation) => ({ ...relation, relation: relation.type })),
  ]
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .slice(0, Math.max(limit, 12));
  return { nodes: selectedNodes, edges: selectedEdges };
}

function formatGraph(memoryStore, limit = 24) {
  const { nodes, edges } = buildGraphSelection(memoryStore, limit);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const lines = [
    "Memact Schema Packet Graph",
    `Schemas: ${memoryStore.schema_packets?.length || 0} | Nodes shown: ${nodes.length} | Edges shown: ${edges.length}`,
    "",
    "Schema Packets",
  ];

  if (!memoryStore.schema_packets?.length) {
    lines.push("- No schema packets formed yet.");
  }

  for (const schema of memoryStore.schema_packets || []) {
    lines.push(`- [schema] ${schema.label}`);
    lines.push(`  id: ${schema.id}`);
    lines.push(`  packet: ${schema.schema_packet_id || "none"}`);
    lines.push(`  strength: ${Number(schema.strength || 0).toFixed(3)} support: ${Number(schema.support || 0)}`);
    if (schema.core_interpretation) lines.push(`  core: ${schema.core_interpretation}`);
    if (schema.action_tendency) lines.push(`  tendency: ${schema.action_tendency}`);
    if (schema.evidence_packet_ids?.length) lines.push(`  evidence: ${schema.evidence_packet_ids.slice(0, 6).join(", ")}`);
    lines.push("");
  }

  lines.push("Nodes");
  for (const node of nodes) {
    lines.push(`- (${formatNodeType(node.type)}) ${nodeLabel(node)} <${node.id}>`);
  }

  lines.push("");
  lines.push("Edges");
  if (!edges.length) {
    lines.push("- No schema edges formed yet.");
  }
  for (const edge of edges) {
    const from = nodeLabel(nodeMap.get(edge.from), edge.from);
    const to = nodeLabel(nodeMap.get(edge.to), edge.to);
    lines.push(`- [${from}] --${edge.relation || edge.type || "related"}--> [${to}] weight=${Number(edge.weight || edge.confidence || 0).toFixed(2)}`);
  }

  return lines.join("\n");
}

function formatMermaid(memoryStore, limit = 24) {
  const { nodes, edges } = buildGraphSelection(memoryStore, limit);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const lines = ["flowchart TD"];
  for (const node of nodes) {
    const id = safeId(node.id);
    const label = `${formatNodeType(node.type)}: ${nodeLabel(node)}`.replace(/"/g, "'");
    lines.push(`  ${id}["${label}"]`);
  }
  for (const edge of edges) {
    const from = safeId(edge.from);
    const to = safeId(edge.to);
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
    const label = String(edge.relation || edge.type || "related").replace(/"/g, "'");
    lines.push(`  ${from} -- "${label}" --> ${to}`);
  }
  return lines.join("\n");
}

function formatDot(memoryStore, limit = 24) {
  const { nodes, edges } = buildGraphSelection(memoryStore, limit);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const lines = ["digraph MemactMemory {", "  rankdir=LR;"];
  for (const node of nodes) {
    lines.push(`  "${node.id}" [label="${formatNodeType(node.type)}: ${nodeLabel(node).replace(/"/g, "'")}"];`);
  }
  for (const edge of edges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${String(edge.relation || edge.type || "related").replace(/"/g, "'")}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

if (query) {
  const options = {};
  if (accessToken) {
    options.accessToken = accessToken;
  }
  
  if (oauthClientId && oauthClientSecret && oauthEndpoint) {
    const service = createEmbeddingService({
      provider: provider || "openai",
      oauth: {
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        tokenEndpoint: oauthEndpoint
      }
    });
    options.queryEmbedding = await service.getEmbedding(query);
  }

  const rag = buildRagContext(query, memoryStore, options);
  const result = retrieveMemories(query, memoryStore, options);
  if (format === "json") {
    console.log(JSON.stringify({ query, rag, memories: result }, null, 2));
  } else {
    console.log(`Memact Memory Retrieval\nQuery: ${query}\n`);
    if (!result.length) {
      console.log("No retained memories matched.");
    } else {
      console.log("RAG Context");
      rag.context_items.forEach((item) => {
        console.log(`- [${item.type}] ${item.label} score=${item.retrieval_score.toFixed(3)}`);
      });
      console.log("");
      console.log("Retrieved Memories");
      result.forEach((memory, index) => {
        console.log(`${index + 1}. ${memory.label}`);
        console.log(`   type=${memory.type} score=${memory.retrieval_score.toFixed(3)} strength=${memory.strength.toFixed(3)}`);
      });
    }
  }
} else if (format === "graph") {
  console.log(formatGraph(memoryStore, graphLimit));
} else if (format === "mermaid") {
  console.log(formatMermaid(memoryStore, graphLimit));
} else if (format === "dot") {
  console.log(formatDot(memoryStore, graphLimit));
} else if (format === "json") {
  console.log(JSON.stringify(memoryStore, null, 2));
} else {
  console.log(formatMemoryReport(memoryStore));
}
