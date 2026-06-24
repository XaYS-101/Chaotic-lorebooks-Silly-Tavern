// deep-extractor.js — deep extraction on top of arc-summary (Phase C).
// Three jobs (SPEC §7 Phase C, §0.4 "code prefilter → cheap AI only on the doubtful"):
//   1) ANTI-HALLUCINATION: strict allow-list — a triple enters the graph ONLY if
//      both entities really appear in the scene OR are already graph nodes. Invented
//      entities create no nodes (the graph grows by ENTITY count — must not bloat with junk).
//   2) SIGNIFICANCE of an arc 0..1 (pure code, synchronous): important arcs → auto-pin
//      and recollection priority; "filler" → fades faster. scoreSignificance() is called
//      by arc-summary BEFORE write (so it affects tier/gist at the right moment).
//   3) DRIFT: a cheap per-arc flag (drift-monitor) — contradiction of an established
//      edge. Flag only, NEVER auto-deletion (the user decides in the UI).
//
// extractArc() — handler for the 'deep-extract' job (autonomous): allow-list → drift →
// graph-merge of filtered triples. Fully guarded: any failure → fallback to direct
// graph-merge of raw triples (no data lost).
//
// Markers: 🟢 significance/allow-list (code) · 🟡 drift (optional LLM, via drift-monitor).

import { getSettings } from '../core/settings.js';
import { loadGraph } from './knowledge-graph.js';
import { extractEntities, entityKey } from './entity-extract.js';
import { stem } from './text-relevance.js';
import { enqueue } from '../core/job-queue.js';
import { checkDriftCheap } from './drift-monitor.js';
import { log as logActivity } from './activity-log.js';

const DRIFT_KEY = 'chaoticLorebooks_drift';
const DRIFT_CAP = 50;

function ctx() { return SillyTavern.getContext(); }

// --- Significance (pure code, synchronous) ---

// Strong relations — an arc that changes one is almost always significant.
const STRONG_REL = new Set(['love', 'hat', 'betray', 'kill', 'die', 'death', 'marry',
  'vow', 'owe', 'alli', 'enemi', 'trust', 'fear', 'leav', 'save', 'lose', 'reveal',
  'promis'].map((w) => stem(w)));

function hasStrongRelation(triples) {
  for (const t of triples || []) {
    const rs = stem(String(t?.rel || '').toLowerCase());
    if (!rs) continue;
    for (const s of STRONG_REL) if (rs.includes(s) || s.includes(rs)) return true;
  }
  return false;
}

/**
 * Score arc significance in [0..1] — pure code, no LLM. Considers strong relations,
 * the number of changed relations, new entities, and length. Triples with off-scene
 * entities are IGNORED (so hallucination can't inflate significance).
 * @param {{triples:Array, text:string, gist?:string}} input
 * @returns {number}
 */
export function scoreSignificance({ triples = [], text = '', gist = '' } = {}) {
  const sceneStems = new Set(extractEntities(text).map((e) => e.stem));
  const real = (triples || []).filter((t) => t && t.from && t.to
    && sceneStems.has(entityKey(t.from)) && sceneStems.has(entityKey(t.to)));

  let score = 0.3;                                    // base
  if (hasStrongRelation(real)) score += 0.3;
  score += Math.min(0.2, real.length * 0.05);        // more changed relations
  const newEntities = sceneStems.size;
  score += Math.min(0.2, newEntities * 0.04);        // entity density
  if (String(text).length < 400) score -= 0.2;       // very short arc — filler
  if (!real.length && !String(gist).trim()) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

// --- Allow-list (anti-hallucination) ---

/** Set of allowed entity stems: scene names ∪ graph nodes (+aliases). */
function buildAllowList(text, knownNodes) {
  const allow = new Set();
  for (const e of extractEntities(text, knownNodes)) allow.add(e.stem);
  for (const n of knownNodes || []) {
    allow.add(entityKey(n.name));
    for (const a of n.aliases || []) allow.add(entityKey(a));
  }
  allow.delete('');
  return allow;
}

function inAllow(allow, name) { return allow.has(entityKey(name)); }

// --- Drift flag store (chatMetadata, per-chat) ---

function driftStore() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[DRIFT_KEY])) meta[DRIFT_KEY] = [];
  return meta[DRIFT_KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

/** All drift flags (for the UI). Unresolved first, newest on top. */
export function getDriftFlags() {
  return driftStore().slice().sort((a, b) =>
    (Number(a.resolved) - Number(b.resolved)) || ((b.addedAt ?? 0) - (a.addedAt ?? 0)));
}

/**
 * Append a batch of drift flags to the shared feed (for the expensive audit — Phase D).
 * Dedup by flagKey (same arcId|kind|from|to|rel not duplicated, including dismissed),
 * plus store cap. Returns the number ACTUALLY added. Sole owner of the feed lives here.
 * @param {Array<{arcId?,kind,from,to,rel,detail?,source?}>} flags
 * @returns {Promise<number>}
 */
export async function addDriftFlags(flags) {
  if (!Array.isArray(flags) || !flags.length) return 0;
  const arr = driftStore();
  let added = 0;
  for (const f of flags) {
    const rec = addFlag(arr, f);
    if (rec) { if (f.source) arr[arr.length - 1].source = f.source; added++; }
  }
  if (added) { capStore(arr); await persist(); }
  return added;
}

/** Dismiss a flag (UI). Mark resolved (not deleted → won't resurface). */
export async function resolveDriftFlag(id) {
  const f = driftStore().find((x) => x.id === id);
  if (!f) return false;
  f.resolved = true;
  await persist();
  return true;
}

function flagKey(f) { return `${f.arcId}|${f.kind}|${entityKey(f.from)}|${entityKey(f.to)}|${stem(String(f.rel || '').toLowerCase())}`; }

/** Append a flag with dedup: same (arcId,kind,from,to,rel) not duplicated. */
function addFlag(arr, f) {
  const key = flagKey(f);
  if (arr.some((x) => flagKey(x) === key)) return false;   // already present (incl. dismissed)
  arr.push({
    id: `d_${f.arcId ?? 'x'}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    arcId: f.arcId ?? null,
    kind: f.kind,
    from: f.from ?? '', to: f.to ?? '', rel: f.rel ?? '',
    detail: String(f.detail || ''),
    resolved: false,
    addedAt: Date.now(),
  });
  return true;
}

/** Trim the store: oldest resolved first, then oldest. */
function capStore(arr) {
  if (arr.length <= DRIFT_CAP) return;
  arr.sort((a, b) => (Number(b.resolved) - Number(a.resolved)) || ((a.addedAt ?? 0) - (b.addedAt ?? 0)));
  arr.splice(0, arr.length - DRIFT_CAP);
}

// --- Main 'deep-extract' job handler ---

/**
 * Deep extraction of a sealed arc. Enqueued instead of 'graph-merge' when
 * deepExtract.enabled. payload = { arcId, triples, text, gist }.
 * @returns {Promise<boolean>}
 */
export async function extractArc(payload) {
  const { arcId, triples, text } = payload || {};
  const s = getSettings();
  try {
    if (!Array.isArray(triples) || !triples.length) return false;
    if (s.graph?.enabled === false) return false;

    const g = await loadGraph();
    const known = Object.values(g.nodes || {});
    const allow = buildAllowList(text, known);

    // 1) allow-list: keep only triples with REAL entities.
    const kept = [];
    const drift = driftStore();
    let changed = false;
    let flagged = 0;
    for (const t of triples) {
      const fromOk = inAllow(allow, t.from);
      const toOk = inAllow(allow, t.to);
      if (fromOk && toOk) { kept.push(t); continue; }
      const ghost = [!fromOk ? t.from : null, !toOk ? t.to : null].filter(Boolean).join(', ');
      if (addFlag(drift, { arcId, kind: 'hallucination', from: t.from, to: t.to, rel: t.rel,
        detail: `сущность вне сцены: ${ghost}` })) { changed = true; flagged++; }
    }

    // 2) drift: doubtful/contradictory relations among the KEPT triples.
    const suspectPairs = [];
    if (s.drift?.cheapEnabled !== false && kept.length) {
      const mode = s.deepExtract?.llmMode ?? 'hybrid';
      const flags = await checkDriftCheap(kept, g, mode, arcId).catch(() => []);
      for (const f of flags) {
        if (addFlag(drift, f)) { changed = true; flagged++; }
        suspectPairs.push([entityKey(f.from), entityKey(f.to)]);
      }
    }

    if (changed) {
      capStore(drift); await persist();
      logActivity({ kind: 'drift', arcId, detail: `${flagged} flag${flagged === 1 ? '' : 's'}` }).catch(() => {});
    }

    // 3) merge cleaned triples into the graph (suspectPairs → marks edges [?]).
    if (kept.length) await enqueue('graph-merge', { arcId, triples: kept, suspectPairs });
    return true;
  } catch (e) {
    console.warn('[ChaoticLorebooks] extractArc failed, falling back to direct merge:', e);
    try {
      if (Array.isArray(triples) && triples.length && s.graph?.enabled !== false) {
        await enqueue('graph-merge', { arcId, triples });
      }
    } catch { /* queue unavailable — do nothing */ }
    return false;
  }
}
