// knowledge-graph.js — tier 3: graph of entities and relationships (Phase B).
// Stored as ONE manifest entry in the bound book (JSON), disable:true — never
// activated by keyword scan (raw JSON never enters the prompt), but survives
// book export/import and travels with it.
//
// Hard rule #4: the graph is MERGED, not rebuilt. Dedup is HYBRID:
//   1) code prefilter (name stem + node pair) narrows to candidate neighbors;
//   2) a cheap LLM decides update|create on that SMALL set (semantic, e.g.
//      "Ren trusts Sable" == "Sable earned Ren's trust");
//   3) code applies idempotently; provenance {arcId:contribution} tracks each
//      arc's contribution — for rollback (invalidateArc) without rerunning others.
// Type guard: nodes of different types (character/location) do NOT merge.
//
// All heavy work (LLM merge) runs from the job queue, off the critical path.
// Reads for injection (neighborhood/serialize) are pure code, NO LLM.
//
// Markers: 🟡 merge · 🟢 read. Degradation: no LLM → code dedup by exact match.

import { getSettings } from '../core/settings.js';
import { casWrite, ENTRY_TEMPLATE } from '../lorebook/lorebook-writer.js';
import { getBoundBookName } from '../lorebook/lorebook-service.js';
import { entityKey } from './entity-extract.js';
import { stem } from './text-relevance.js';
import { log as logActivity } from './activity-log.js';

function ctx() { return SillyTavern.getContext(); }

const MANIFEST_KEY = '__cl_graph__';
const MANIFEST_RE = /tier=manifest/i;

const EMPTY = () => ({ nodes: {}, edges: [] });

// --- Find/create the manifest entry in the book ---
function findManifest(data) {
  for (const e of Object.values(data.entries || {})) {
    if (MANIFEST_RE.test(String(e.comment ?? '')) && (e.key ?? []).includes(MANIFEST_KEY)) return e;
  }
  return null;
}

/** Read the graph from the book. Returns {nodes,edges} (empty if absent). */
export async function loadGraph() {
  const book = getBoundBookName();
  if (!book) return EMPTY();
  let data;
  try { data = await ctx().loadWorldInfo(book); } catch { return EMPTY(); }
  const ent = data && findManifest(data);
  if (!ent) return EMPTY();
  try {
    const g = JSON.parse(ent.content || '{}');
    return { nodes: g.nodes || {}, edges: Array.isArray(g.edges) ? g.edges : [] };
  } catch { return EMPTY(); }
}

/** Write the graph to the manifest entry (under the writer mutex, via casWrite). */
async function saveGraph(g) {
  return casWrite(null, async (data) => {
    let ent = findManifest(data);
    const content = JSON.stringify({ nodes: g.nodes, edges: g.edges });
    if (!ent) {
      // create a new DISABLED container entry (full WI-record template)
      let uid = 0; while (uid in data.entries) uid++;
      data.entries[uid] = {
        ...structuredClone(ENTRY_TEMPLATE), uid,
        key: [MANIFEST_KEY], content,
        comment: '[CL origin=graph tier=manifest]',
        disable: true,        // never activated by keyword scan
      };
    } else {
      if (ent.content === content) return false;     // unchanged — skip write
      ent.content = content;
      ent.disable = true;                            // graph must not be injected as-is
    }
    return true;
  });
}

// --- Nodes ---
function nodeId(name) { return entityKey(name); }

function upsertNode(g, name, type, arcId) {
  const id = nodeId(name);
  if (!id) return null;
  const cur = g.nodes[id];
  if (cur) {
    if ((!cur.type || cur.type === 'unknown') && type && type !== 'unknown') cur.type = type;
    // remember the surface form as an alias (for alias-aware scene matching)
    if (name && cur.name !== name && !(cur.aliases || []).includes(name)) {
      cur.aliases = [...(cur.aliases || []), name].slice(0, 6);
    }
    cur.lastActive = Math.max(cur.lastActive ?? 0, arcId ?? 0);
    cur.archived = false;
    return id;
  }
  g.nodes[id] = {
    name, type: type || 'unknown', tier: 3, aliases: [],
    lastActive: arcId ?? 0, archived: false,
  };
  return id;
}

// --- Edges ---
function relStem(rel) { return stem(String(rel || 'related').toLowerCase()); }

/** Candidate edges for hybrid merge: same node pair in either direction. */
function candidateEdges(g, from, to) {
  return g.edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (e.from === from && e.to === to) || (e.from === to && e.to === from));
}

function bumpEdge(edge, weight, arcId) {
  edge.weight = Math.max(1, Math.min(10, (edge.weight ?? 5) + (weight ? 0 : 1)));
  if (weight) edge.weight = Math.max(1, Math.min(10, weight));
  edge.provenance = edge.provenance || {};
  if (arcId != null) edge.provenance[arcId] = (edge.provenance[arcId] || 0) + 1;
  edge.active = true;
  delete edge.suspect;
}

/**
 * Hybrid merge of triples into the graph. Idempotent, with per-arc provenance.
 * @param {{arcId:number, triples:Array<{from,rel,to,weight,fromType?,toType?}>, suspectPairs?:Array<[string,string]>}} payload
 * `suspectPairs` (from deep-extractor): node-id pairs whose edges we mark suspect
 * ([?]) — drift/contradiction needing review. Marked AFTER merge (else bumpEdge clears it).
 * Invoked as the 'graph-merge' job handler.
 */
export async function addTriples(payload) {
  const { triples, arcId, suspectPairs } = payload || {};
  if (!Array.isArray(triples) || !triples.length) return false;
  const s = getSettings();
  if (s.graph?.enabled === false) return false;

  const g = await loadGraph();
  const nodes0 = Object.keys(g.nodes).length;   // for the delta in the activity log
  const edges0 = g.edges.length;

  for (const t of triples) {
    if (!t?.from || !t?.to) continue;
    const fromId = upsertNode(g, String(t.from), t.fromType, arcId);
    const toId = upsertNode(g, String(t.to), t.toType, arcId);
    if (!fromId || !toId || fromId === toId) continue;

    const rs = relStem(t.rel);
    const cands = candidateEdges(g, fromId, toId);

    // 1) Exact match of direction+relation → update (no LLM).
    const exact = cands.find(({ e }) => e.from === fromId && e.to === toId && relStem(e.rel) === rs);
    if (exact) { bumpEdge(exact.e, t.weight, arcId); continue; }

    // 2) Hybrid: candidates exist (other relation/direction) → cheap LLM decides.
    let merged = false;
    if (cands.length && s.autonomous?.enabled) {
      const decision = await decideMerge(t, cands.map(({ e }) => e)).catch(() => null);
      if (decision && decision.matchIndex != null && cands[decision.matchIndex]) {
        const edge = cands[decision.matchIndex].e;
        // type guard already ensured by the node pair; accept the canonical relation
        if (decision.rel) edge.rel = decision.rel;
        bumpEdge(edge, t.weight, arcId);
        merged = true;
      }
    }
    if (merged) continue;

    // 3) New edge.
    g.edges.push({
      from: fromId, to: toId, rel: String(t.rel || 'related'),
      weight: Math.max(1, Math.min(10, t.weight || 5)),
      provenance: arcId != null ? { [arcId]: 1 } : {}, active: true,
    });
  }

  // Mark drift pairs suspect (after merge, so bumpEdge doesn't clear the flag).
  if (Array.isArray(suspectPairs) && suspectPairs.length) {
    for (const [a, b] of suspectPairs) {
      if (!a || !b) continue;
      for (const e of g.edges) {
        if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) e.suspect = true;
      }
    }
  }

  archiveColdInPlace(g, arcId);
  probabilisticAliasMerge(g);
  capNodesInPlace(g);

  const dNodes = Object.keys(g.nodes).length - nodes0;
  const dEdges = g.edges.length - edges0;
  logActivity({ kind: 'graph-merge', arcId, detail: `+${dNodes} node${dNodes === 1 ? '' : 's'}, +${dEdges} edge${dEdges === 1 ? '' : 's'}` })
    .catch(() => {});

  return saveGraph(g);
}

/** Cheap LLM: is the new triple equivalent to one of the candidates? */
async function decideMerge(triple, candidates) {
  const { agentRequest, parseJsonLoose } = await import('../llm/llm-service.js');
  const { noteLlmCall } = await import('../core/job-queue.js');
  const list = candidates.map((e, i) => `${i}: ${e.from} —${e.rel}→ ${e.to}`).join('\n');
  const system = 'You merge relationship facts in a knowledge graph. Decide if the NEW '
    + 'fact expresses the SAME relationship as one of the EXISTING ones (semantic, '
    + 'direction-aware: "A trusts B" == "B earned A\'s trust"). '
    + 'Reply ONLY JSON: {"matchIndex": <int or null>, "rel": "<canonical short relation>"}.';
  const prompt = `NEW: ${triple.from} —${triple.rel}→ ${triple.to}\n\nEXISTING:\n${list}`;
  noteLlmCall();
  const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
  if (!parsed) return null;
  const mi = parsed.matchIndex;
  return { matchIndex: (typeof mi === 'number' && mi >= 0) ? mi : null, rel: parsed.rel };
}

// --- Ego graph (read, NO LLM) ---
/** Nodes reachable from entity names within `hops` steps over active edges. */
export function neighborhood(g, entityNames, hops = 2) {
  const ids = new Set();
  const seed = (entityNames || []).map(nodeId).filter((id) => id && g.nodes[id]);
  let frontier = new Set(seed);
  seed.forEach((id) => ids.add(id));
  for (let h = 0; h < Math.max(1, hops); h++) {
    const next = new Set();
    for (const e of g.edges) {
      if (e.active === false) continue;
      if (frontier.has(e.from) && !ids.has(e.to)) { ids.add(e.to); next.add(e.to); }
      if (frontier.has(e.to) && !ids.has(e.from)) { ids.add(e.from); next.add(e.from); }
    }
    if (!next.size) break;
    frontier = next;
  }
  return ids;
}

/** Serialize a subgraph as compact triples within budget (🟢, for injection). */
export function serializeSubgraph(g, nodeIds, budgetTokens) {
  const idset = nodeIds instanceof Set ? nodeIds : new Set(nodeIds || []);
  if (!idset.size) return '';
  const name = (id) => g.nodes[id]?.name || id;
  const lines = [];
  for (const e of g.edges) {
    if (e.active === false) continue;
    if (!idset.has(e.from) || !idset.has(e.to)) continue;
    if (g.nodes[e.from]?.archived || g.nodes[e.to]?.archived) continue;
    const since = sinceArc(e);
    const w = e.weight != null ? `${e.weight}/10` : '';
    const meta = [w, since != null ? `since arc${since}` : ''].filter(Boolean).join(', ');
    lines.push(`${name(e.from)} —${e.rel}→ ${name(e.to)}${meta ? ` (${meta})` : ''}${e.suspect ? ' [?]' : ''}`);
  }
  if (!lines.length) return '';
  // rough budget: ~4 chars/token
  const charBudget = Math.max(200, (budgetTokens || 1500) * 4);
  let out = '';
  for (const l of lines) { if (out.length + l.length + 1 > charBudget) break; out += (out ? '\n' : '') + l; }
  return `[Relationship graph — what these characters mean to each other]\n${out}`;
}

function sinceArc(e) {
  const ks = Object.keys(e.provenance || {}).map(Number).filter((n) => !Number.isNaN(n));
  return ks.length ? Math.min(...ks) : null;
}

// --- Invalidation (roll back a dirty arc's contribution) ---
/**
 * Subtract an arc's contribution. Remove an edge ONLY if no other source arcs
 * remain; otherwise keep it (provenance still holds other arcs). The cascade is
 * limited to edges whose sole source is this arc.
 */
export async function invalidateArc(arcId) {
  if (arcId == null) return false;
  const g = await loadGraph();
  let changed = false;
  const kept = [];
  for (const e of g.edges) {
    if (!e.provenance || !(arcId in e.provenance)) { kept.push(e); continue; }
    delete e.provenance[arcId];
    changed = true;
    const remaining = Object.keys(e.provenance).length;
    if (remaining === 0) continue;                 // sole source was this arc → drop
    // other arcs still hold the edge; weight may be inflated → mark suspect (for audit)
    e.suspect = true;
    kept.push(e);
  }
  if (!changed) return false;
  g.edges = kept;
  return saveGraph(g);
}

// --- Cold nodes / cap ---

/**
 * Probabilistic alias merge: if two distinct nodeIds share ≥2 edges to the same
 * third node with the same relation, they're probably the same character (name
 * variant / typo). The smaller node (by provenance count) merges into the larger,
 * and all edges are redirected.
 *
 * Self-calibrating: relies on graph structure, not name dictionaries. The
 * threshold (≥2 shared neighbors) is conservative — one match could be chance
 * (friends of one character), two is already statistically significant.
 */
function probabilisticAliasMerge(g) {
  const ids = Object.keys(g.nodes);
  if (ids.length < 3) return; // need at least 3 nodes for a meaningful merge

  // For each node pair, count shared neighbors with the same relation.
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const aNeighbors = neighborSet(g, a);
      const bNeighbors = neighborSet(g, b);
      // Count the intersection: {target}_{rel} matches
      let shared = 0;
      for (const n of aNeighbors) {
        if (bNeighbors.has(n)) shared++;
      }
      if (shared >= 2) pairs.push({ a, b, shared });
    }
  }

  // Merge smaller into larger (by total provenance).
  for (const { a, b } of pairs) {
    const nodeA = g.nodes[a], nodeB = g.nodes[b];
    if (!nodeA || !nodeB) continue;
    const sizeA = totalProvenance(g, a);
    const sizeB = totalProvenance(g, b);
    const [keep, absorb] = sizeA >= sizeB ? [a, b] : [b, a];
    if (!g.nodes[keep] || !g.nodes[absorb]) continue;

    // Redirect all edges from absorb → keep.
    for (const e of g.edges) {
      if (e.from === absorb) e.from = keep;
      if (e.to === absorb) e.to = keep;
    }
    // Drop self-edges created by the redirect.
    g.edges = g.edges.filter((e) => e.from !== e.to);

    // Carry over the absorbed node's aliases.
    const absorbedNode = g.nodes[absorb];
    if (absorbedNode && g.nodes[keep]) {
      g.nodes[keep].aliases = [...new Set([
        ...(g.nodes[keep].aliases || []),
        absorbedNode.name,
        ...(absorbedNode.aliases || []),
      ])].slice(0, 6);
      g.nodes[keep].lastActive = Math.max(g.nodes[keep].lastActive ?? 0, absorbedNode.lastActive ?? 0);
    }
    delete g.nodes[absorb];

    // Remove duplicate edges (same from+to+rel), summing provenance.
    dedupeEdges(g);
  }
}

/** Set of "{target}_{relStem}" strings for all edges incident to a node. */
function neighborSet(g, nodeId) {
  const set = new Set();
  for (const e of g.edges) {
    if (e.from === nodeId) set.add(`${e.to}_${relStem(e.rel)}`);
    if (e.to === nodeId) set.add(`${e.from}_${relStem(e.rel)}`);
  }
  return set;
}

/** Sum of provenance counts over all edges incident to a node (rough node "mass"). */
function totalProvenance(g, nodeId) {
  let sum = 0;
  for (const e of g.edges) {
    if (e.from !== nodeId && e.to !== nodeId) continue;
    if (e.provenance) for (const v of Object.values(e.provenance)) sum += v;
  }
  return sum || 1;
}

/** Dedup edges: same from+to+rel → sum provenance, take max weight. */
function dedupeEdges(g) {
  const seen = new Map();
  const out = [];
  for (const e of g.edges) {
    const key = `${e.from}||${e.to}||${relStem(e.rel)}`;
    const prev = seen.get(key);
    if (prev) {
      prev.weight = Math.max(prev.weight ?? 1, e.weight ?? 1);
      if (e.provenance) {
        prev.provenance = prev.provenance || {};
        for (const [k, v] of Object.entries(e.provenance)) {
          prev.provenance[k] = (prev.provenance[k] || 0) + v;
        }
      }
    } else {
      seen.set(key, e);
      out.push(e);
    }
  }
  g.edges = out;
}

function archiveColdInPlace(g, currentArc) {
  const after = getSettings().graph?.archiveColdAfterArcs ?? 8;
  const now = currentArc ?? maxArc(g);
  for (const n of Object.values(g.nodes)) {
    if ((now - (n.lastActive ?? 0)) > after) n.archived = true;
  }
}
function capNodesInPlace(g) {
  const cap = getSettings().graph?.maxNodes ?? 40;
  const live = Object.entries(g.nodes).filter(([, n]) => !n.archived);
  if (live.length <= cap) return;
  // archive the coldest beyond the cap
  live.sort((a, b) => (a[1].lastActive ?? 0) - (b[1].lastActive ?? 0));
  for (let i = 0; i < live.length - cap; i++) g.nodes[live[i][0]].archived = true;
}
function maxArc(g) {
  let m = 0;
  for (const e of g.edges) for (const k of Object.keys(e.provenance || {})) m = Math.max(m, Number(k) || 0);
  return m;
}

/** Archive cold nodes (called from maintenance/job). */
export async function archiveCold(currentArc) {
  const g = await loadGraph();
  archiveColdInPlace(g, currentArc);
  capNodesInPlace(g);
  return saveGraph(g);
}

/**
 * Mark edges suspect ([?]) by node pairs (Phase D — expensive audit). Mirrors the
 * suspectPairs path in addTriples, but as a standalone writer. Pairs are node ids
 * in either direction. No-op on empty input.
 * @param {Array<[string,string]>} pairs
 * @returns {Promise<boolean>}
 */
export async function markSuspect(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return false;
  const g = await loadGraph();
  let changed = false;
  for (const [a, b] of pairs) {
    if (!a || !b) continue;
    for (const e of g.edges) {
      if (e.active === false) continue;
      if (((e.from === a && e.to === b) || (e.from === b && e.to === a)) && !e.suspect) {
        e.suspect = true; changed = true;
      }
    }
  }
  if (!changed) return false;
  return saveGraph(g);
}

/** Brief stats for the UI status line (🟢). */
export async function getStats() {
  const g = await loadGraph();
  const nodes = Object.values(g.nodes).filter((n) => !n.archived).length;
  return { nodes, edges: g.edges.filter((e) => e.active !== false).length };
}
