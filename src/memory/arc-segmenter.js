// arc-segmenter.js — slice chat into "arcs" + watermark + dirty flags (SPEC §0.3, §3b).
// Incremental: process only the new tail; never touch sealed arcs; a substantial
// edit of an old message marks ONLY that arc dirty.
//
// Watermark "trails the live tip by 1": a swipeable/editable last message doesn't
// enter memory until the user accepts it (settle gate).
//
// Markers: 🟢 (marker/cap slicing — no LLM; "where to cut at cap" — optional job).

import { getSettings } from '../core/settings.js';
import { contentTokens, jaccard } from './text-relevance.js';
import { trace } from '../core/debug-trace.js';

const ARCS_KEY = 'chaoticLorebooks_arcs';
const WM_KEY = 'chaoticLorebooks_watermark';
const BASELINE_KEY = 'chaoticLorebooks_baseline';

// Scene/arc boundary markers.
const ARC_MARKER_RE = /(^|\s)\/cl-arc\b/i;
const SCENE_BREAK_RE = /^\s*([-*_=]{3,}|\*\s*\*\s*\*|\[\s*scene\s*break\s*\]|timeskip)\s*$/im;

function ctx() { return SillyTavern.getContext(); }
function chat() { return ctx().chat ?? []; }

function arcs() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[ARCS_KEY])) meta[ARCS_KEY] = [];
  return meta[ARCS_KEY];
}
function getWatermark() { return ctx().chatMetadata?.[WM_KEY] ?? -1; }
function setWatermark(v) { const m = ctx().chatMetadata; if (m) m[WM_KEY] = v; }
export function getBaseline() { const v = ctx().chatMetadata?.[BASELINE_KEY]; return v == null ? null : v; }
function setBaseline(v) { const m = ctx().chatMetadata; if (m) m[BASELINE_KEY] = v; }
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

// In-memory snapshot of message text for the typo gate on edits.
const textSnap = new Map();

function tokHash(text) {
  // compact "fingerprint" of an arc's token set for coarse invalidation.
  const toks = contentTokens(text).sort();
  let h = 5381; const s = toks.join(' ');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The open (unsealed) arc; create one if absent. */
export function getOpenArc() {
  const a = arcs();
  let open = a.find((x) => !x.sealed);
  if (!open) {
    // Empty + baseline set → forward arcs start AT baseline (the historical prefix
    // [0..baseline-1] is left uncovered so auto-hide won't touch it; backfill later
    // slices it into arcs via sealRange).
    const base = getBaseline();
    const prevEnd = a.length
      ? Math.max(...a.map((x) => x.end ?? -1))
      : (base != null ? base - 1 : -1);
    open = { id: a.length, start: prevEnd + 1, end: null, sealed: false, dirty: false, tokensHash: '', summaryGist: '' };
    a.push(open);
  }
  return open;
}

/** Text of an arc's slab (by message indices). */
function slabText(start, end) {
  return chat().slice(start, end + 1).map((m) => `${m?.name}: ${m?.mes}`).join('\n');
}

/** Whether a boundary marker exists in the range (start..end inclusive). */
function hasMarker(start, end) {
  const arc = getSettings().arc ?? {};
  const useMarkers = arc.useMarkers !== false;   // explicit /cl-arc command
  const useBreaks = arc.useSceneBreaks === true; // drawn separators (off by default)
  if (!useMarkers && !useBreaks) return false;
  for (let i = start; i <= end; i++) {
    const t = chat()[i]?.mes ?? '';
    if (useMarkers && ARC_MARKER_RE.test(t)) return true;
    if (useBreaks && SCENE_BREAK_RE.test(t)) return true;
  }
  return false;
}

/**
 * Called on EVERY settled turn (not a swipe). Updates the watermark and seals the
 * open arc if it's ripe (cap or marker). Returns the sealed arc (or null) so the
 * orchestrator can enqueue the summary job and run auto-hide.
 */
export async function onMessage() {
  const len = chat().length;
  if (len === 0) return null;

  // watermark = second-to-last message (trail the tip by 1).
  const wm = Math.max(getWatermark(), len - 2);
  setWatermark(wm);

  // refresh the text snapshot for the typo gate (only up to watermark — settled).
  for (let i = 0; i <= wm; i++) {
    if (!textSnap.has(i)) textSnap.set(i, chat()[i]?.mes ?? '');
  }

  const open = getOpenArc();
  if (open.start > wm) { await persist(); return null; }     // nothing to seal yet

  const cap = Math.max(5, getSettings().arc?.capMessages ?? 40);
  const minLen = Math.max(2, getSettings().arc?.minMessages ?? 6);
  const lenInArc = wm - open.start + 1;
  const capReached = lenInArc >= cap;
  // A marker only seals an arc at least minLen long (anti short-arc).
  const marker = lenInArc >= minLen && hasMarker(open.start, wm);

  if (!capReached && !marker) { await persist(); return null; }

  const sealed = await sealReady(capReached ? 'cap' : 'marker');
  await persist();
  return sealed;
}

/** Seal the open arc up to the watermark. Returns the arc or null. */
export async function sealReady(reason = 'manual') {
  const wm = getWatermark();
  const open = getOpenArc();
  if (open.start > wm) return null;

  open.end = wm;
  open.sealed = true;
  open.tokensHash = tokHash(slabText(open.start, open.end));
  trace('arc.seal', { arc: open.id, start: open.start, end: open.end, len: open.end - open.start + 1, reason });

  // the next open arc starts right after.
  const a = arcs();
  a.push({ id: a.length, start: wm + 1, end: null, sealed: false, dirty: false, tokensHash: '', summaryGist: '' });
  await persist();
  return open;
}

/** Mark an arc dirty (after a substantial edit of an old message). */
export async function markDirty(arcId) {
  const arc = arcs().find((x) => x.id === arcId);
  if (arc && arc.sealed && !arc.dirty) { arc.dirty = true; await persist(); }
}

/** The arc containing a message index (or null). */
function arcOfIndex(i) {
  return arcs().find((x) => x.sealed && i >= x.start && i <= (x.end ?? -1)) || null;
}

/**
 * Handle a message edit (MESSAGE_EDITED event). Typo gate: an edit below the word
 * threshold is ignored (don't wake agents). Only a substantial one marks the arc dirty.
 */
export async function onEdit(index) {
  const i = Number(index);
  if (Number.isNaN(i)) return;
  const arc = arcOfIndex(i);
  if (!arc) { textSnap.set(i, chat()[i]?.mes ?? ''); return; }   // edit in the live window — not memory

  const oldText = textSnap.get(i);
  const newText = chat()[i]?.mes ?? '';
  textSnap.set(i, newText);
  if (oldText == null) return;            // old text unknown (after restart) — leave it

  const threshold = getSettings().arc?.editDirtyThreshold ?? 0.10;
  const sim = jaccard(contentTokens(oldText), contentTokens(newText));
  if ((1 - sim) >= threshold) {
    arc.dirty = true;
    arc.tokensHash = tokHash(slabText(arc.start, arc.end));
    await persist();
    return arc;            // substantial edit → orchestrator rolls back/re-extracts the arc
  }
  return null;             // typo — leave the arc alone
}

/** All sealed arcs (for auto-hide / summary). */
export function getSealedArcs() { return arcs().filter((x) => x.sealed); }

/** Arc by id (or null). */
export function getArc(arcId) { return arcs().find((x) => x.id === arcId) || null; }

/** Arc slab text (start..end) — for summary/extraction. */
export function arcText(arcId) {
  const a = getArc(arcId);
  if (!a || a.start == null || a.end == null) return '';
  return slabText(a.start, a.end);
}

/** Store an arc's summary gist (arc-summary, after processing). */
export async function setSummaryGist(arcId, gist) {
  const a = getArc(arcId);
  if (!a) return false;
  a.summaryGist = String(gist ?? '');
  a.dirty = false;            // cleanly processed
  await persist();
  return true;
}

/**
 * Store an arc's significance 0..1 (deep-extractor, Phase C). Read by the UI badge
 * and the auto-pin decision. Invalid → 0.5. Idempotent.
 */
export async function setArcSignificance(arcId, score) {
  const a = getArc(arcId);
  if (!a) return false;
  const n = Number(score);
  a.significance = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  await persist();
  return true;
}

/**
 * Reconcile inherited arcs to the chat branch length (branch-guard, after a fork).
 * The branch is truncated at the fork point → arcs starting past the end describe
 * the parent's "future" that isn't here: drop them; mark the arc straddling the
 * boundary dirty (re-extracts cleanly); clamp the watermark to the new end.
 * Best-effort, guarded. Returns the number of removed arcs.
 */
export async function reconcileArcsToChat() {
  try {
    const meta = ctx().chatMetadata;
    if (!meta || !Array.isArray(meta[ARCS_KEY])) return 0;
    const last = chat().length - 1;          // index of the branch's last message
    const before = meta[ARCS_KEY].length;
    // Drop arcs lying entirely past the branch end.
    meta[ARCS_KEY] = meta[ARCS_KEY].filter((a) => (a.start ?? 0) <= last);
    for (const a of meta[ARCS_KEY]) {
      if (a.sealed && (a.end ?? -1) > last) {
        a.end = last;                        // trim to the branch end
        a.dirty = true;                      // content changed → re-extract
      }
    }
    const removed = before - meta[ARCS_KEY].length;
    if (getWatermark() > last) setWatermark(last);
    textSnap.clear();
    await persist();
    return removed;
  } catch (e) {
    console.warn('[ChaoticLorebooks] reconcileArcsToChat failed:', e);
    return 0;
  }
}

/** Reset the snapshot on chat switch (arc metadata is per-chat). */
export function reset() { textSnap.clear(); }

// ===== Backfill: late-enabled chat =====

/**
 * First contact with an existing chat: if the extension never saw this chat
 * (no watermark) AND chat length > threshold, plant a baseline so getOpenArc
 * starts there and the historical prefix [0..baseline-1] stays intact for backfill
 * (no mega-arcs, no blind auto-hide).
 * Idempotent: re-call after baseline is set — no-op.
 * Returns true if anything was planted.
 */
export async function seedBaselineIfNeeded(threshold = 10) {
  const meta = ctx().chatMetadata;
  if (!meta) return false;
  // Already known? — bail.
  if (meta[WM_KEY] != null || meta[BASELINE_KEY] != null) return false;
  const len = chat().length;
  if (len <= threshold) return false;      // short chat → legacy behavior
  setWatermark(len - 2);
  setBaseline(len);
  await persist();
  return true;
}

/**
 * How many messages in [0..baseline-1] are NOT yet covered by a sealed arc.
 * Returns 0 if no baseline was planted or the prefix is already covered.
 */
export function uncoveredPrefixLen() {
  const base = getBaseline();
  if (base == null) return 0;
  const a = arcs();
  let covered = 0;
  for (const x of a) {
    if (!x.sealed || x.start == null || x.end == null) continue;
    if (x.start >= base) continue;
    const lo = Math.max(0, x.start);
    const hi = Math.min(base - 1, x.end);
    if (hi >= lo) covered += (hi - lo + 1);
  }
  return Math.max(0, base - covered);
}

/** id for the next arc — unique (above all existing). */
function nextArcId() {
  const a = arcs();
  return a.length ? Math.max(...a.map((x) => Number(x.id) || 0)) + 1 : 0;
}

/**
 * Seal the range [start..end] as a finished sealed arc (for backfilling the
 * historical prefix). The open forward arc is left untouched.
 */
export async function sealRange(start, end, opts = {}) {
  if (!(end >= start) || start < 0) return null;
  const a = arcs();
  const arc = {
    id: nextArcId(),
    start, end,
    sealed: true, dirty: false,
    foundation: !!opts.foundation,
    tokensHash: tokHash(slabText(start, end)),
    summaryGist: '',
  };
  a.push(arc);
  trace('arc.seal', { arc: arc.id, start, end, len: end - start + 1, reason: 'backfill' });
  return arc;
}

/**
 * Slice the uncovered prefix [0..baseline-1] into sealed arcs by capMessages.
 * Mark the earliest foundation:true. Idempotent: if the prefix is already covered, [].
 * Returns the ids of the newly created arcs.
 */
export async function backfillArcs() {
  const base = getBaseline();
  if (base == null || base <= 0) return [];
  const cap = Math.max(5, getSettings().arc?.capMessages ?? 40);

  // Find already-covered ranges in [0..base-1] so we only cut the gaps.
  const sealedInPrefix = arcs()
    .filter((x) => x.sealed && x.start != null && x.end != null && x.start < base)
    .map((x) => ({ start: Math.max(0, x.start), end: Math.min(base - 1, x.end) }))
    .sort((p, q) => p.start - q.start);

  const ids = [];
  let cursor = 0;
  let first = true;
  for (const seg of sealedInPrefix) {
    if (seg.start > cursor) {
      const fromIds = await chunkAndSeal(cursor, seg.start - 1, cap, first);
      ids.push(...fromIds);
      first = false;
    }
    cursor = Math.max(cursor, seg.end + 1);
  }
  if (cursor <= base - 1) {
    const fromIds = await chunkAndSeal(cursor, base - 1, cap, first);
    ids.push(...fromIds);
  }
  if (ids.length) await persist();
  return ids;
}

async function chunkAndSeal(lo, hi, cap, firstIsFoundation) {
  const out = [];
  let s = lo;
  let first = firstIsFoundation;
  while (s <= hi) {
    const e = Math.min(s + cap - 1, hi);
    const arc = await sealRange(s, e, { foundation: first && s === 0 });
    if (arc) out.push(arc.id);
    first = false;
    s = e + 1;
  }
  return out;
}
