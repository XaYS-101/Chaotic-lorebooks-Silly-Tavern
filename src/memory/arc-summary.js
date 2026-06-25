// arc-summary.js — extraction from a sealed arc (Phase B, 🟡).
// One pass per arc (hard rule #3 — incremental): a cheap LLM reads the arc slab
// and returns:
//   - gist        — 1-3 sentences of the arc's essence (for tier 2);
//   - voiceQuotes — 2-4 VERBATIM character lines (preserve voice);
//   - triples     — relationships {from,rel,to,weight} for the graph (tier 3).
// Then:
//   - store the gist on the arc (arc-segmenter.setSummaryGist);
//   - add a gist to recollection (tier 2);
//   - enqueue 'graph-merge' (hybrid triple merge off the critical path);
//   - write a STANDALONE keyed arc entry to the book (origin=auto-arc) — the book
//     remembers the arc by keywords even with the extension disabled.
//
// Called ONLY from the 'arc-extract' job handler (autonomous). Degradation: LLM
// returns null → arc not processed, queue retries (up to 3), chat unaffected.

import { getSettings, backgroundJobsAllowed } from '../core/settings.js';
import { agentRequest, parseJsonLoose } from '../llm/llm-service.js';
import { noteLlmCall, enqueue } from '../core/job-queue.js';
import { getArc, arcText, setSummaryGist, setArcSignificance } from './arc-segmenter.js';
import { addGist } from './recollection.js';
import { enqueueWrite } from '../lorebook/lorebook-writer.js';
import { extractEntities } from './entity-extract.js';
import { loadGraph } from './knowledge-graph.js';
import { scoreSignificance } from './deep-extractor.js';
import { log as logActivity } from './activity-log.js';
import { getBuffer } from './thought-buffer.js';

const SCHEMA = {
  type: 'object',
  properties: {
    gist: { type: 'string' },
    voiceQuotes: { type: 'array', items: { type: 'string' } },
    triples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' }, rel: { type: 'string' },
          to: { type: 'string' }, weight: { type: 'number' },
        },
        required: ['from', 'rel', 'to'],
      },
    },
  },
  required: ['gist'],
};

/**
 * Process a sealed arc. Returns true on success, false on degradation.
 * @param {number} arcId
 * @param {{force?: boolean}} [opts] force=true — manual rerun from UI: bypasses the
 *   mode gate (works even in lite) and ignores an existing gist (re-summarizes).
 */
export async function summarizeArc(arcId, opts = {}) {
  const force = !!opts.force;
  const s = getSettings();
  if (s.extraction?.enabled === false && !force) return false;
  // Arc summary is a cheap background job: runs in all modes except lite (where
  // memory isn't built at all). One-time backfill (late-enabled chat) runs even in
  // lite — its flag lives in chatMetadata, checked by the queue. Manual force runs everywhere.
  const backfillActive = !!(SillyTavern.getContext().chatMetadata?.chaoticLorebooks_backfillActive);
  if (!backgroundJobsAllowed(s) && !backfillActive && !force) return false;

  const arc = getArc(arcId);
  if (!arc || !arc.sealed) return false;
  const text = arcText(arcId);
  if (!text || text.length < 20) { await setSummaryGist(arcId, ''); return false; }

  // Anti-hallucination hint: rank known entities by relevance to this arc (names
  // present in the scene first) so the hint stays useful as the graph grows.
  let knownNames = [];
  try {
    const names = Object.values((await loadGraph()).nodes).map((n) => n.name).filter(Boolean);
    const norm = text.toLowerCase();
    knownNames = names
      .map((name) => ({ name, hit: norm.includes(name.toLowerCase()) }))
      .sort((a, b) => (b.hit - a.hit))
      .map((x) => x.name)
      .slice(0, 40);
  } catch { /* ok */ }
  const quotesN = Math.max(2, Math.min(4, s.recollection?.voiceQuotesPerArc ?? 3));

  // Active goals from the thought buffer — the LLM marks progress/completion in the gist.
  const goals = getBuffer().filter((i) => i.kind === 'goal' && i.weight > 0);
  const goalsBlock = goals.length
    ? `Active character goals (note any progress, completion, or newly emerged goals):\n`
      + `${goals.map((g) => `- [${(g.importance || 1) >= 3 ? 'MAIN' : 'side'}] ${g.text}`).join('\n')}\n\n`
    : '';

  const system = 'You compress one scene ("arc") of a roleplay into durable memory. '
    + 'Prioritize lasting content: goals and their progress, relationship changes, facts that '
    + 'may resurface later, and callbacks to earlier events; omit unchanging background. '
    + 'Output JSON only with: '
    + '"gist" (1-3 sentences, the lasting consequences of the scene, not a play-by-play); '
    + `"voiceQuotes" (${quotesN} VERBATIM short lines characters actually said, preserving voice); `
    + '"triples" (relationship changes as {from, rel, to, weight 1-10}; use SHORT relations '
    + 'like trusts/fears/loves/owes/allied_with/located_in; prefer the entity names listed if they match). '
    + 'If active goals are provided, note any progress or completion in the gist. '
    + 'Do NOT invent entities not present in the scene.';
  const prompt = (knownNames.length ? `Known entities: ${knownNames.join(', ')}\n\n` : '')
    + goalsBlock
    + `Scene transcript:\n${text}`;

  let parsed;
  try {
    parsed = parseJsonLoose(await agentRequest({ system, prompt, jsonSchema: SCHEMA }));
    // Only count the call against budget AFTER a successful result — failed calls
    // should not exhaust the hourly cap and block real work.
    if (parsed && parsed.gist) noteLlmCall();
  } catch (e) {
    console.warn('[ChaoticLorebooks] summarizeArc LLM failed:', e);
    return false;
  }
  if (!parsed || !parsed.gist) return false;

  const gist = String(parsed.gist).trim();
  const voiceQuotes = Array.isArray(parsed.voiceQuotes)
    ? parsed.voiceQuotes.map(String).filter(Boolean).slice(0, quotesN) : [];
  const triples = Array.isArray(parsed.triples)
    ? parsed.triples.filter((t) => t && t.from && t.to && t.rel) : [];

  // H6: calibrated confidence — validate entities and quotes against the arc text.
  const { scoredTriples, hallucinated } = validateTriples(triples, text);
  const validatedQuotes = validateQuotes(voiceQuotes, text);

  // Phase C: arc significance (pure code, synchronous) — affects pinning and gist
  // priority at write time. deep-extract off → neutral 0.5 (legacy behavior).
  const deep = s.deepExtract?.enabled && s.autonomous?.enabled;
  const significance = deep ? scoreSignificance({ triples: scoredTriples, text, gist }) : 0.5;

  // 1) arc gist onto the arc itself + into tier 2 (with significance for decay priority)
  await setSummaryGist(arcId, gist);
  if (deep) await setArcSignificance(arcId, significance);
  const refs = entityKeysFromTriples(scoredTriples);
  await addGist({ gist, voiceQuotes: validatedQuotes, graphRefs: refs, arcId, significance });

  // 2) triples → graph. With deep-extract: first allow-list/drift (job 'deep-extract'),
  //    which itself enqueues a cleaned 'graph-merge'. Otherwise direct merge (as in Phase B).
  //    Hallucinations (confidence='low') → weight ×0.5 before merge.
  if (deep) {
    await enqueue('deep-extract', { arcId, triples: scoredTriples, text, gist, hallucinated });
  } else if (scoredTriples.length && s.graph?.enabled !== false) {
    await enqueue('graph-merge', { arcId, triples: scoredTriples });
  }
  // Record hallucinations as drift flags for manual review.
  if (hallucinated.length) {
    try {
      const { addDriftFlags } = await import('./deep-extractor.js');
      const flags = hallucinated.map((h) => ({
        kind: 'hallucination',
        arcId,
        from: h.from,
        to: h.to,
        rel: h.rel,
        detail: `"${h.from}" → "${h.to}" (${h.rel}): not found in arc text`,
      }));
      await addDriftFlags(flags).catch(() => {});
    } catch { /* deep-extractor unavailable — skip flagging */ }
  }

  // 3) STANDALONE keyed arc entry (book remembers even without the extension).
  //    Arc 0 = foundation of introductions → auto-pin; a significant arc (≥ pinThreshold) too.
  const keys = deriveArcKeys(scoredTriples, text);
  const isFoundation = arc.foundation === true || arcId === 0;
  const pinned = isFoundation || (deep && significance >= (s.deepExtract?.pinThreshold ?? 0.7));
  const content = [gist, ...voiceQuotes.map((q) => `“${q}”`)].join('\n');
  await enqueueWrite({
    origin: 'auto-arc',
    tier: pinned ? 'pinned' : 'transient',
    arc: arcId,
    content,
    title: `Arc ${arcId}`,
    treePath: isFoundation ? 'Foundation' : 'Arcs',
    key: keys,
  }).catch((e) => console.warn('[ChaoticLorebooks] arc entry write failed:', e));

  logActivity({ kind: 'extract', arcId, detail: `gist + ${triples.length} triple${triples.length === 1 ? '' : 's'}` })
    .catch(() => {});

  return true;
}

function entityKeysFromTriples(triples) {
  const set = new Set();
  for (const t of triples) { if (t.from) set.add(String(t.from)); if (t.to) set.add(String(t.to)); }
  return [...set].slice(0, 12);
}

/** Keys for the standalone entry: triple entities, else proper nouns from the text. */
function deriveArcKeys(triples, text) {
  const fromTriples = entityKeysFromTriples(triples);
  if (fromTriples.length) return fromTriples.slice(0, 6);
  return extractEntities(text).slice(0, 6).map((e) => e.name);
}

// --- H6: Calibrated confidence — pure-code validation ---

/**
 * Validate triples against the arc text. Each entity (from/to) must appear in the
 * arc text (else it's a hallucination). Returns scoredTriples (with a _confidence
 * field) and a separate hallucinated list (confidence='low').
 */
function validateTriples(triples, arcText) {
  const norm = String(arcText ?? '').toLowerCase();
  const scored = [];
  const hallucinated = [];
  for (const t of triples) {
    const fromConf = entityConfidence(t.from, norm);
    const toConf = entityConfidence(t.to, norm);
    // Conservative: confidence = min(from, to) — if either entity is missing,
    // the whole triple is suspect.
    const conf = Math.min(fromConf, toConf);
    const scoredT = { ...t, _confidence: conf };
    if (conf < 0.4) {
      // Low confidence → weight ×0.5 on merge into the graph.
      scoredT.weight = Math.max(1, Math.round((scoredT.weight ?? 5) * 0.5));
      hallucinated.push(scoredT);
    }
    scored.push(scoredT);
  }
  return { scoredTriples: scored, hallucinated };
}

/**
 * Look up an entity in the arc text. exact match → 1.0, fuzzy (all words present)
 * → 0.7, partial match → 0.4, absent → 0.1.
 */
function entityConfidence(name, normText) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return 0.5;
  // Exact substring match (name as a whole phrase).
  if (normText.includes(n)) return 1.0;
  // Fuzzy: all name tokens present in the text.
  const tokens = n.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => normText.includes(t))) return 0.7;
  // Partial: at least one token >3 chars present.
  if (tokens.some((t) => t.length > 3 && normText.includes(t))) return 0.4;
  // Entirely absent → probable hallucination.
  return 0.1;
}

/**
 * Validate voice quotes: each must be found (allowing punctuation/capitalization
 * variation) in the arc text. Returns only the confirmed ones.
 */
function validateQuotes(quotes, arcText) {
  const norm = String(arcText ?? '').toLowerCase().replace(/[.,!?;:'"()\-—«»„"`'']/g, '');
  return quotes.filter((q) => {
    const qNorm = String(q).toLowerCase().replace(/[.,!?;:'"()\-—«»„"`'']/g, '');
    // Quote must be ≥8 chars and appear in full within the cleaned arc text.
    return qNorm.length >= 8 && norm.includes(qNorm);
  });
}

// --- Auto-regeneration of empty arc summaries ---

const EMPTY_GIST_COUNT_KEY = 'chaoticLorebooks_emptyGistRetryCount';

/**
 * Settled-turn counter for regenerating empty arc summaries.
 * Returns true once every N turns (default 3). Ignores swipes —
 * MESSAGE_SWIPED doesn't call onSettledTurn.
 */
export async function noteSettledForEmptyGistRetry(every = 3) {
  const meta = SillyTavern.getContext().chatMetadata;
  if (!meta) return false;
  const n = (Number(meta[EMPTY_GIST_COUNT_KEY]) || 0) + 1;
  if (n >= every) { meta[EMPTY_GIST_COUNT_KEY] = 0; try { await SillyTavern.getContext().saveMetadata(); } catch { /* ok */ } return true; }
  meta[EMPTY_GIST_COUNT_KEY] = n;
  try { await SillyTavern.getContext().saveMetadata(); } catch { /* ok */ }
  return false;
}

/**
 * Find all sealed arcs with an empty summaryGist and enqueue them for
 * re-extraction (force=true, bypasses the lite gate). Returns the count found.
 */
export async function retryEmptyGistArcs() {
  const { getSealedArcs, arcText } = await import('./arc-segmenter.js');
  const { enqueue } = await import('../core/job-queue.js');
  // Only retry arcs with enough text to summarize (≥20 chars) — shorter arcs
  // will never produce a useful summary and would retry indefinitely.
  const arcs = getSealedArcs().filter((a) => !a.summaryGist && (arcText(a.id)?.length ?? 0) >= 20);
  for (const a of arcs) {
    await enqueue('arc-extract', { arcId: a.id, force: true }).catch(() => {});
  }
  return arcs.length;
}
