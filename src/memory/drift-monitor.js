// drift-monitor.js — detect memory "drift" (Phase C, partial).
// Drift = a new fact CONTRADICTS an established graph edge (e.g. was
// "Ren —trusts→ Sable (8)", now "Ren —betrays→ Sable"). Nothing is deleted
// automatically (hard rule: the user always wins) — only a FLAG for review.
// The expensive cross-arc audit (auditExpensive) is a Phase D stub.
//
// Two cost levels (user picks via deepExtract.llmMode):
//   'code'   — code only: explicit relation antonyms (0 LLM);
//   'hybrid' — code for explicit + cheap LLM ONLY on ambiguous pairs (like hybrid merge);
//   'full'   — one cheap LLM pass over all arc triples against the neighborhood.
//
// Markers: 🟢 baseline (code), 🟡 hybrid/full. Degradation: LLM=null → code result.

import { stem } from './text-relevance.js';
import { entityKey } from './entity-extract.js';
import { getSettings } from '../core/settings.js';
import { log as logActivity } from './activity-log.js';

function relStem(rel) { return stem(String(rel || 'related').toLowerCase()); }

// Explicit relation antonyms (by stem). Made symmetric below.
const OPP_RAW = [
  ['trusts', 'betrays'],
  ['loves', 'hates'],
  ['allied_with', 'enemy_of'],
  ['protects', 'threatens'],
  ['helps', 'harms'],
  ['befriends', 'betrays'],
  ['serves', 'rebels_against'],
  ['frees', 'captures'],
  ['saves', 'kills'],
];
const OPPOSITE = new Map();
for (const [a, b] of OPP_RAW) {
  OPPOSITE.set(relStem(a), relStem(b));
  OPPOSITE.set(relStem(b), relStem(a));
}

// "Negative" relations — signal an ambiguous pair for hybrid mode when there's no
// explicit antonym in the map but a tone flip is evident.
const NEGATIVE = new Set(['betrays', 'hates', 'kills', 'harms', 'threatens',
  'abandons', 'deceives', 'fears', 'enemy_of', 'rebels_against', 'captures',
  'attacks', 'distrusts'].map(relStem));

function isOpposite(a, b) { return OPPOSITE.get(a) === b; }
function isNegative(r) { return NEGATIVE.has(r); }

/** Active graph edges on the same node pair (either direction). */
function pairEdges(graph, fromId, toId) {
  return (graph.edges || []).filter((e) => e.active !== false
    && ((e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)));
}

function mkFlag(arcId, t, exEdge, detail) {
  return {
    arcId,
    kind: 'contradiction',
    from: String(t.from),
    to: String(t.to),
    rel: String(t.rel || 'related'),
    detail: detail || `было «${exEdge.rel}», стало «${t.rel}»`,
  };
}

/**
 * Cheap per-arc drift flagging. Compares NEW (already allow-list-filtered) triples
 * against established graph edges.
 * @param {Array<{from,rel,to,weight}>} triples
 * @param {{nodes,edges}} graph
 * @param {'code'|'hybrid'|'full'} [llmMode='hybrid']
 * @param {number|null} [arcId]
 * @returns {Promise<Array<{arcId,kind,from,to,rel,detail}>>}
 */
export async function checkDriftCheap(triples, graph, llmMode = 'hybrid', arcId = null) {
  const flags = [];
  const ambiguous = [];
  if (!Array.isArray(triples) || !triples.length || !graph) return flags;

  for (const t of triples) {
    if (!t?.from || !t?.to) continue;
    const fromId = entityKey(t.from);
    const toId = entityKey(t.to);
    if (!fromId || !toId) continue;
    const newRel = relStem(t.rel);
    for (const e of pairEdges(graph, fromId, toId)) {
      const exRel = relStem(e.rel);
      if (exRel === newRel) continue;                 // same relation — not drift
      if (isOpposite(exRel, newRel)) {
        flags.push(mkFlag(arcId, t, e));              // explicit antonym → flag, no LLM
      } else if (isNegative(newRel) !== isNegative(exRel)) {
        ambiguous.push({ t, e });                     // tone flip → ambiguous, defer to hybrid/full
      }
    }
  }

  if (llmMode === 'code') return flags;

  if (llmMode === 'full') {
    const extra = await fullDriftPass(triples, graph, arcId).catch(() => []);
    flags.push(...extra);
    return dedupe(flags);
  }

  // hybrid: cheap LLM judges ONLY ambiguous pairs (like the graph hybrid merge).
  for (const { t, e } of ambiguous) {
    // eslint-disable-next-line no-await-in-loop
    const verdict = await adjudicate(t, e).catch(() => null);
    if (verdict && verdict.contradiction) {
      flags.push(mkFlag(arcId, t, e, verdict.detail));
    }
  }
  return dedupe(flags);
}

function dedupe(flags) {
  const seen = new Set();
  const out = [];
  for (const f of flags) {
    const k = `${f.from}|${f.to}|${relStem(f.rel)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** Cheap LLM: does the new fact CONTRADICT the old, or is it natural development? */
async function adjudicate(t, exEdge) {
  const { agentRequest, parseJsonLoose } = await import('../llm/llm-service.js');
  const { noteLlmCall } = await import('../core/job-queue.js');
  const system = 'You audit a roleplay knowledge graph for CONTRADICTIONS. Decide if the '
    + 'NEW relationship fact contradicts the EXISTING one, or is natural character '
    + 'development (evolution is NOT a contradiction). '
    + 'Reply ONLY JSON: {"contradiction": <true|false>, "detail": "<short reason>"}.';
  const prompt = `EXISTING: ${exEdge.from} —${exEdge.rel}→ ${exEdge.to} (weight ${exEdge.weight ?? '?'})\n`
    + `NEW: ${t.from} —${t.rel}→ ${t.to}`;
  const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
  if (!parsed) return null;
  // Only count against budget after a successful result.
  noteLlmCall();
  return { contradiction: parsed.contradiction === true, detail: String(parsed.detail || '') };
}

/** One cheap pass over the whole arc against the neighborhood ('full' mode). */
async function fullDriftPass(triples, graph, arcId) {
  const { agentRequest, parseJsonLoose } = await import('../llm/llm-service.js');
  const { noteLlmCall } = await import('../core/job-queue.js');
  const { neighborhood, serializeSubgraph } = await import('./knowledge-graph.js');
  const names = [...new Set(triples.flatMap((t) => [t.from, t.to]).filter(Boolean).map(String))];
  const ids = neighborhood(graph, names, 1);
  const existing = serializeSubgraph(graph, ids, 1200) || '(no established relationships yet)';
  const incoming = triples.map((t) => `${t.from} —${t.rel}→ ${t.to}`).join('\n');
  const system = 'You audit a roleplay knowledge graph. List relationship facts in NEW that '
    + 'CONTRADICT the ESTABLISHED graph (not mere evolution). '
    + 'Reply ONLY JSON: {"contradictions":[{"from":"","to":"","rel":"","detail":""}]}.';
  const prompt = `ESTABLISHED:\n${existing}\n\nNEW:\n${incoming}`;
  const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
  const arr = Array.isArray(parsed?.contradictions) ? parsed.contradictions : [];
  if (arr.length) noteLlmCall();
  return arr.filter((c) => c && c.from && c.to).map((c) => ({
    arcId, kind: 'contradiction',
    from: String(c.from), to: String(c.to), rel: String(c.rel || 'related'),
    detail: String(c.detail || 'cross-arc contradiction'),
  }));
}

// ============ Phase D: expensive cross-arc audit ============
//
// The cheap flag (checkDriftCheap) looks ONLY at the new arc against the graph AT
// seal time. It's blind to contradictions visible only CROSS-ARC:
//   - two active edges on ONE node pair with antonym/tone-flip relations, added at
//     DIFFERENT times (each passed the cheap check on its own);
//   - edges marked suspect (invalidateArc after a dirty arc) and not yet reviewed;
//   - tone flips deferred by the cheap pass as "ambiguous".
// The audit scans the WHOLE graph, finds candidates in code, then ONE LLM pass
// judges which are real contradictions vs natural development. Degradation: no LLM /
// not autonomous → only structurally certain (explicit antonyms + suspect).
// NEVER deletes — only flags (into the shared drift feed) + edge [?] marks.

const AUDIT_COUNT_KEY = 'chaoticLorebooks_auditCount';

function ctx() { return SillyTavern.getContext(); }

/** Key for an unordered node pair. */
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

/** Earliest source arc of an edge (by provenance) — to localize the flag. */
function sinceArc(e) {
  const ks = Object.keys(e?.provenance || {}).map(Number).filter((n) => !Number.isNaN(n));
  return ks.length ? Math.min(...ks) : null;
}

/** Candidate flag from an edge pair: "new" (later arc) vs "old". */
function flagFromEdges(eOld, eNew) {
  const a = sinceArc(eOld);
  const b = sinceArc(eNew);
  // "newer" = larger earliest source arc (ties → the second).
  const newer = (b ?? 0) >= (a ?? 0) ? eNew : eOld;
  const older = newer === eNew ? eOld : eNew;
  return {
    arcId: sinceArc(newer),
    kind: 'contradiction',
    from: String(newer.from), to: String(newer.to), rel: String(newer.rel || 'related'),
    detail: `Аудит: было «${older.rel}», стало «${newer.rel}»`,
    source: 'audit',
  };
}

/**
 * Cross-arc graph audit. Pure function (no writes): returns flags, suspect pairs,
 * and a summary. `llm:true` → one LLM pass refines candidates.
 * @param {{nodes,edges}} graph
 * @param {{llm?:boolean}} [opts]
 * @returns {Promise<{flags:Array, suspectPairs:Array<[string,string]>, summary:string}>}
 */
export async function auditExpensive(graph, { llm = false } = {}) {
  const empty = { flags: [], suspectPairs: [], summary: 'clean' };
  if (!graph || !Array.isArray(graph.edges) || !graph.edges.length) return empty;

  const active = graph.edges.filter((e) => e.active !== false);

  // Group active edges by unordered node pair.
  const byPair = new Map();
  for (const e of active) {
    if (!e.from || !e.to || e.from === e.to) continue;
    const k = pairKey(e.from, e.to);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(e);
  }

  const certain = [];     // (a) explicit antonyms + (c) suspect — structurally certain
  const ambiguous = [];   // (b) tone flip — ambiguous, judged by LLM

  for (const edges of byPair.values()) {
    // (c) lone suspect edges — re-review (weight may be inflated).
    for (const e of edges) {
      if (e.suspect === true) {
        certain.push({
          arcId: sinceArc(e), kind: 'contradiction',
          from: String(e.from), to: String(e.to), rel: String(e.rel || 'related'),
          detail: `Аудит: подозрительная связь «${e.rel}» (помечена ранее)`, source: 'audit',
        });
      }
    }
    // edge pairs on the same node pair — antonyms / tone flip.
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const r1 = relStem(edges[i].rel);
        const r2 = relStem(edges[j].rel);
        if (r1 === r2) continue;
        if (isOpposite(r1, r2)) certain.push(flagFromEdges(edges[i], edges[j]));
        else if (isNegative(r1) !== isNegative(r2)) ambiguous.push({ e1: edges[i], e2: edges[j] });
      }
    }
  }

  // Degradation: without LLM, return only the structurally certain.
  if (!llm) {
    const flags = dedupe(certain);
    return { flags, suspectPairs: flags.map((f) => [entityKey(f.from), entityKey(f.to)]),
      summary: summarize(flags) };
  }

  // ONE LLM pass judges the ambiguous tone flips (expensive profile, via job-queue/budget).
  let judged = [];
  if (ambiguous.length) {
    judged = await auditPass(graph, ambiguous).catch(() => []);
  }
  const flags = dedupe([...certain, ...judged]);
  return { flags, suspectPairs: flags.map((f) => [entityKey(f.from), entityKey(f.to)]),
    summary: summarize(flags) };
}

function summarize(flags) {
  return flags.length ? `${flags.length} cross-arc contradiction${flags.length === 1 ? '' : 's'}` : 'clean';
}

/** One cheap pass over all ambiguous graph pairs (tone flips). */
async function auditPass(graph, ambiguous) {
  const { agentRequest, parseJsonLoose } = await import('../llm/llm-service.js');
  const { noteLlmCall } = await import('../core/job-queue.js');
  const name = (id) => graph.nodes?.[id]?.name || id;
  const lines = ambiguous.map(({ e1, e2 }, i) =>
    `${i}: ${name(e1.from)} —${e1.rel}→ ${name(e1.to)}  VS  ${name(e2.from)} —${e2.rel}→ ${name(e2.to)}`).join('\n');
  const system = 'You audit a roleplay knowledge graph for CROSS-ARC CONTRADICTIONS. Each line '
    + 'lists two established relationship facts about the same pair of characters. Decide which '
    + 'pairs are genuine CONTRADICTIONS (not natural character development — evolution is NOT a '
    + 'contradiction). Reply ONLY JSON: {"contradictions":[{"index":<int>,"detail":"<short reason>"}]}.';
  const prompt = `PAIRS:\n${lines}`;
  const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
  const arr = Array.isArray(parsed?.contradictions) ? parsed.contradictions : [];
  if (arr.length) noteLlmCall();
  const out = [];
  for (const c of arr) {
    const pair = ambiguous[Number(c?.index)];
    if (!pair) continue;
    const f = flagFromEdges(pair.e1, pair.e2);
    if (c.detail) f.detail = `Аудит: ${String(c.detail)}`;
    out.push(f);
  }
  return out;
}

/**
 * Full audit run: load graph → find contradictions → write flags to the shared
 * drift feed + mark edges suspect → reset the counter. Dynamic imports avoid a
 * static cycle with deep-extractor (which imports us).
 * @param {{paidAllowed?:boolean}} [opts] paidAllowed → ONE LLM pass is allowed
 * @returns {Promise<{added:number, summary:string}>}
 */
export async function runAudit({ paidAllowed = false } = {}) {
  try {
    const { loadGraph } = await import('./knowledge-graph.js');
    const mode = getSettings().deepExtract?.llmMode ?? 'hybrid';
    const graph = await loadGraph();
    const { flags, suspectPairs, summary } = await auditExpensive(graph, { llm: paidAllowed && mode !== 'code' });

    let added = 0;
    if (flags.length) {
      const { addDriftFlags } = await import('./deep-extractor.js');
      added = await addDriftFlags(flags);
      const { markSuspect } = await import('./knowledge-graph.js');
      await markSuspect(suspectPairs).catch(() => {});
    }
    resetAuditCounter();
    logActivity({ kind: 'audit', detail: added ? `${added} new flag${added === 1 ? '' : 's'} · ${summary}` : `clean · ${summary}` })
      .catch(() => {});
    return { added, summary };
  } catch (e) {
    console.warn('[ChaoticLorebooks] runAudit failed:', e);
    return { added: 0, summary: 'audit failed' };
  }
}

// --- "Once per ~N settled turns" counter (persisted in chat metadata) ---

/**
 * Note a settled turn. Returns true (and resets the counter) when it's time to
 * run the expensive audit (count ≥ drift.auditEveryNMessages).
 */
export function noteSettledForAudit() {
  const meta = ctx().chatMetadata;
  if (!meta) return false;
  const every = Math.max(1, getSettings().drift?.auditEveryNMessages ?? 500);
  const n = (Number(meta[AUDIT_COUNT_KEY]) || 0) + 1;
  if (n >= every) { meta[AUDIT_COUNT_KEY] = 0; persistMeta(); return true; }
  meta[AUDIT_COUNT_KEY] = n;
  persistMeta();
  return false;
}

/** Reset the audit counter (after a run). */
export function resetAuditCounter() {
  const meta = ctx().chatMetadata;
  if (meta) { meta[AUDIT_COUNT_KEY] = 0; persistMeta(); }
}

function persistMeta() { try { ctx().saveMetadata(); } catch { /* no-op */ } }
