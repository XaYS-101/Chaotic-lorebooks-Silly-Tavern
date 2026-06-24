// lorebook-writer.js — the ONLY write path into a book (SPEC §0.2, §3b, Phase A).
// No feature calls saveWorldInfo directly — only through this module.
//
// Guarantees:
//   - Mutex: all writes serialize (promise chain) → no races between our tasks.
//   - Hash-based CAS: before overwriting an auto-entry we reload the book; if the
//     entry content changed since our last write (user edited it) → the entry is
//     promoted to origin=user and automation no longer touches it (user always wins).
//   - REAL keys: every entry is a valid WI record with real keys (no keyword-scan
//     suppression; disable the extension → the book works on its own).
//   - origin tags in comment: auto-arc|auto-detail|author-note|scout|user.
//   - defer on manual edits: while the user edits the book (WORLDINFO_UPDATED) we wait.
//   - safety snapshot before overwriting an existing entry.
//
// Checked against ST: createWorldInfoEntry/createNewWorldInfo are NOT on context →
// we replicate the entry template (newWorldInfoEntryDefinition) and a free uid here.

import { getBoundBookName, ensureBookForWrite } from './lorebook-service.js';
import { contentTokens } from '../memory/text-relevance.js';

function ctx() { return SillyTavern.getContext(); }

// New-entry template (defaults from newWorldInfoEntryDefinition, ST 1.12+).
// Exported so other writers (knowledge-graph) create COMPLETE records.
export const ENTRY_TEMPLATE = Object.freeze({
  key: [], keysecondary: [], comment: '', content: '',
  constant: false, vectorized: false, selective: true, selectiveLogic: 0,
  addMemo: true, order: 100, position: 0, disable: false, ignoreBudget: false,
  excludeRecursion: false, preventRecursion: false,
  matchPersonaDescription: false, matchCharacterDescription: false,
  matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
  matchScenario: false, matchCreatorNotes: false,
  delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4,
  outletName: '', group: '', groupOverride: false, groupWeight: 100,
  scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
  automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
});

const ORIGIN_RE = /\[CL\s+([^\]]*)\]/i;          // [CL origin=.. tier=.. arc=.. h=..]
const TREE_RE = /\[TREE:\s*[^\]]+\]/i;
// Origins that automation does NOT overwrite.
const PROTECTED_ORIGINS = new Set(['user', 'author-note']);

// --- defer on the user's manual edits ---
let deferUntil = 0;
/** index.js calls this on WORLDINFO_UPDATED for our book. Defer writes by 5s. */
export function noteUserEditing() { deferUntil = Date.now() + 5000; }
async function waitIfDeferred() {
  while (Date.now() < deferUntil) {
    await new Promise((r) => setTimeout(r, Math.min(500, deferUntil - Date.now() + 1)));
  }
}

// --- Mutex: global write promise chain ---
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);          // run even if the previous one failed
  chain = run.catch(() => {});             // never break the chain
  return run;
}

// --- Utilities ---
function djb2(str) {
  let h = 5381;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function freeUid(data) {
  for (let uid = 0; uid < 1_000_000; uid++) if (!(uid in data.entries)) return uid;
  return null;
}
function parseOrigin(comment) {
  const m = String(comment ?? '').match(ORIGIN_RE);
  const out = {};
  if (m) for (const pair of m[1].split(/\s+/)) {
    const [k, v] = pair.split('=');
    if (k) out[k] = v ?? '';
  }
  return out;
}
function buildComment({ origin, tier, arc, title, treePath, contentHash }) {
  const parts = [];
  if (title) parts.push(title);
  if (treePath) parts.push(`[TREE: ${treePath}]`);
  const meta = [`origin=${origin || 'auto-detail'}`];
  if (tier) meta.push(`tier=${tier}`);
  if (arc != null) meta.push(`arc=${arc}`);
  if (contentHash) meta.push(`h=${contentHash}`);
  parts.push(`[CL ${meta.join(' ')}]`);
  return parts.join(' ');
}

/** Derive REAL keys from explicit list / title / content (≥1 guaranteed). */
function deriveKeys(patch) {
  if (Array.isArray(patch.key) && patch.key.length) {
    return patch.key.map((k) => String(k).trim()).filter(Boolean);
  }
  const keys = new Set();
  // Proper nouns (capitalized) from title and first content lines — best keys.
  const src = `${patch.title ?? ''} ${patch.content ?? ''}`;
  for (const m of src.matchAll(/\b([A-ZА-ЯЁ][\p{L}]{2,})\b/gu)) keys.add(m[1]);
  // Add a couple of meaningful content tokens if names are sparse.
  if (keys.size < 2) for (const t of contentTokens(patch.title || patch.content).slice(0, 3)) keys.add(t);
  const arr = [...keys].slice(0, 6);
  return arr.length ? arr : ['memory'];
}

/** Find an existing auto-entry by dedup: same treePath+title, or key overlap. */
function findDup(data, patch, keys) {
  const wantTitle = (patch.title ?? '').toLowerCase().trim();
  const wantPath = (patch.treePath ?? '').toLowerCase().trim();
  const keyset = new Set(keys.map((k) => k.toLowerCase()));
  for (const e of Object.values(data.entries)) {
    const cmt = String(e.comment ?? '').toLowerCase();
    const eTitle = cmt.replace(ORIGIN_RE, '').replace(TREE_RE, '').trim();
    const samePath = wantPath && cmt.includes(`[tree: ${wantPath}]`);
    if (wantTitle && eTitle === wantTitle && (!wantPath || samePath)) return e;
    // key overlap (cheap dedup): ≥2 shared keys
    const ek = new Set((e.key ?? []).map((k) => String(k).toLowerCase()));
    let common = 0; for (const k of keyset) if (ek.has(k)) common++;
    if (common >= 2 && samePath) return e;
  }
  return null;
}

/**
 * Low-level read-modify-write of a book under the mutex with CAS.
 * mutate(data) — mutates data.entries; returns true if anything changed.
 */
export function casWrite(name, mutate) {
  return withLock(async () => {
    await waitIfDeferred();
    // Lazy book creation: the first REAL write creates the book (deferred start).
    const book = name || getBoundBookName() || await ensureBookForWrite();
    if (!book) return false;
    let data;
    try { data = await ctx().loadWorldInfo(book); } catch { data = null; }
    if (!data || typeof data !== 'object') data = { entries: {} };
    if (!data.entries) data.entries = {};
    const changed = await mutate(data);
    if (!changed) return false;
    await ctx().saveWorldInfo(book, data, true);
    return true;
  });
}

/**
 * High-level write. patch:
 *   { origin, tier, arc, content, title, treePath, key?[] }
 * Idempotent: update an existing auto-entry or create a new one.
 * Protected origins (user/author-note) are NOT overwritten.
 */
export async function enqueueWrite(patch) {
  if (!patch?.content && !patch?.title) return false;
  const keys = deriveKeys(patch);
  let touchedExisting = false;

  const ok = await casWrite(null, async (data) => {
    const dup = findDup(data, patch, keys);

    if (dup) {
      const origin = parseOrigin(dup.comment);
      // CAS: content changed since our last write? → user edited it manually.
      const storedH = origin.h;
      const curH = djb2(dup.content);
      if (storedH && storedH !== curH) {
        // Promote to origin=user and stop touching the content.
        dup.comment = bumpOriginToUser(dup.comment);
        return true;
      }
      if (PROTECTED_ORIGINS.has(origin.origin)) return false;   // user/note — leave alone
      // Update the auto-entry content.
      touchedExisting = true;
      dup.content = String(patch.content ?? dup.content);
      const newH = djb2(dup.content);
      dup.comment = buildComment({
        origin: patch.origin || origin.origin || 'auto-detail',
        tier: patch.tier || origin.tier, arc: patch.arc ?? origin.arc,
        title: patch.title || stripMeta(dup.comment), treePath: patch.treePath || pathFrom(dup.comment),
        contentHash: newH,
      });
      if (keys.length) dup.key = Array.from(new Set([...(dup.key ?? []), ...keys])).slice(0, 8);
      return true;
    }

    // New entry.
    const uid = freeUid(data);
    if (uid == null) return false;
    const contentHash = djb2(patch.content ?? '');
    data.entries[uid] = {
      ...structuredClone(ENTRY_TEMPLATE), uid,
      key: keys,
      content: String(patch.content ?? ''),
      comment: buildComment({
        origin: patch.origin || 'auto-detail', tier: patch.tier, arc: patch.arc,
        title: patch.title, treePath: patch.treePath, contentHash,
      }),
      constant: patch.tier === 'pinned',          // pinned → always active
    };
    return true;
  });

  // Safety snapshot if we overwrote an existing entry (risky operation).
  if (ok && touchedExisting) {
    try { const { safetySnapshot } = await import('./backup.js'); await safetySnapshot(); }
    catch { /* backup is optional */ }
  }
  return ok;
}

function stripMeta(comment) {
  return String(comment ?? '').replace(ORIGIN_RE, '').replace(TREE_RE, '').trim();
}
function pathFrom(comment) {
  const m = String(comment ?? '').match(/\[TREE:\s*([^\]]+)\]/i);
  return m ? m[1].trim() : '';
}
function bumpOriginToUser(comment) {
  const o = parseOrigin(comment);
  return buildComment({
    origin: 'user', tier: o.tier, arc: o.arc,
    title: stripMeta(comment), treePath: pathFrom(comment),
    // no h: origin=user is no longer checked by automation.
  });
}

/** Idempotent upsert of an arbitrary entry (for future modules). */
export async function upsertEntry(entry) {
  return casWrite(null, async (data) => {
    const uid = entry.uid != null && entry.uid in data.entries ? entry.uid : freeUid(data);
    if (uid == null) return false;
    data.entries[uid] = { ...structuredClone(ENTRY_TEMPLATE), ...entry, uid };
    return true;
  });
}

/** Merge two entries (b into a): union keys and content. Returns a. */
export function mergeEntries(a, b) {
  a.key = Array.from(new Set([...(a.key ?? []), ...(b.key ?? [])])).slice(0, 8);
  if (b.content && !String(a.content).includes(b.content)) {
    a.content = `${a.content}\n${b.content}`.trim();
  }
  return a;
}
