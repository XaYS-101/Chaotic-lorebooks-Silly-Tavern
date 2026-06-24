// favorites.js — saved messages (★) and QUOTES (parts of messages). One model
// with a per-item INJECTION MODE. Stored in chatMetadata. All 🟢
// (except →lorebook and mode='relevant'+AI — marked).
//
// Item model:
//   { id, mesIndex, text, kind:'message'|'quote',
//     mode:'permanent'|'chance'|'relevant',   // how it enters the injection
//     enabled, pinned, addedAt }
//   permanent — always after the main prompt (as emphasis)
//   chance    — has a chance to resurface as a memory (depth 3-4)
//   relevant  — injected when relevant to the scene (algorithm; v1: AI decides)

import { getSettings } from '../core/settings.js';
import { contentTokens, bm25Rank } from '../memory/text-relevance.js';
import { ensureBook } from '../lorebook/lorebook-service.js';
import { t } from '../core/i18n.js';

function recentQueryTokens() {
  return (ctx().chat ?? []).slice(-4).flatMap((m) => contentTokens(m.mes));
}

const META_KEY = 'chaoticLorebooks_favorites';
function ctx() { return SillyTavern.getContext(); }

export function getFavorites() {
  const meta = ctx().chatMetadata;
  if (!Array.isArray(meta[META_KEY])) meta[META_KEY] = [];
  return meta[META_KEY];
}
async function persist() { await ctx().saveMetadata(); }

export function isFav(mesIndex) {
  return getFavorites().some((f) => f.mesIndex === mesIndex && f.kind !== 'quote');
}

/**
 * A message was deleted in chat → shift mesIndex of items above it, drop those
 * tied to the deleted one or now past the chat length. The star stops glowing
 * on its own after re-render.
 */
export async function reconcileFavoritesAfterDelete(deletedIdx) {
  const favs = getFavorites();
  if (!favs.length) return;
  const len = ctx().chat?.length ?? 0;
  let changed = false;
  for (let i = favs.length - 1; i >= 0; i--) {
    const f = favs[i];
    if (typeof f.mesIndex !== 'number') continue;
    if (Number.isFinite(deletedIdx) && deletedIdx >= 0) {
      if (f.mesIndex === deletedIdx) { favs.splice(i, 1); changed = true; continue; }
      if (f.mesIndex > deletedIdx) { f.mesIndex -= 1; changed = true; }
    }
    if (f.mesIndex >= len) { favs.splice(i, 1); changed = true; }
  }
  if (changed) await persist();
}

/** ★ on the WHOLE message (toggle). Default mode permanent. */
export async function toggleFavorite(mesIndex, text) {
  const favs = getFavorites();
  const idx = favs.findIndex((f) => f.mesIndex === mesIndex && f.kind !== 'quote');
  if (idx >= 0) { favs.splice(idx, 1); }
  else {
    const mes = ctx().chat?.[mesIndex];
    favs.push(mk(mesIndex, text || mes?.mes || '', 'message', 'permanent'));
  }
  await persist();
  return isFav(mesIndex);
}

/** Add a SELECTED quote (part of a message). Additive. Default mode from settings. */
export async function addQuote(mesIndex, text, mode) {
  if (!text?.trim()) return;
  const def = getSettings().quotes?.defaultMode || 'chance';
  getFavorites().push(mk(mesIndex, text, 'quote', mode || def));
  await persist();
}

function mk(mesIndex, text, kind, mode) {
  return {
    id: `${kind[0]}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    mesIndex, text: String(text).trim(),
    kind, mode, enabled: true, pinned: false, addedAt: Date.now(),
  };
}

// --- Editor CRUD ---
export async function editText(id, text) { const f = find(id); if (f) { f.text = text; await persist(); } }
export async function setEnabled(id, on) { const f = find(id); if (f) { f.enabled = !!on; await persist(); } }
export async function setPinned(id, on) { const f = find(id); if (f) { f.pinned = !!on; await persist(); } }
export async function setMode(id, mode) { const f = find(id); if (f) { f.mode = mode; await persist(); } }
export async function removeFavorite(id) {
  const favs = getFavorites(); const i = favs.findIndex((f) => f.id === id);
  if (i >= 0) { favs.splice(i, 1); await persist(); }
}
function find(id) { return getFavorites().find((x) => x.id === id); }

/** Promote into a permanent lorebook entry ("eternal" tier). ⚠FLAG: via lorebook-writer (Phase 4). */
export async function saveAsEntry(id) {
  const f = find(id); if (!f) return false;
  f.pinned = true; f.enabled = true; f.mode = 'permanent';
  await persist();
  // Explicit user action → may show the book-choice popup (if askOnFirstUse).
  await ensureBook(getSettings());
  // Write as a pinned (origin=user) entry through the single queue.
  try {
    const { enqueueWrite } = await import('../lorebook/lorebook-writer.js');
    await enqueueWrite({
      origin: 'user', tier: 'pinned',
      content: f.text,
      treePath: 'Pinned',
      title: (f.text.split(/\s+/).slice(0, 4).join(' ') || 'Pinned memory'),
    });
    globalThis.toastr?.success?.(t('toast.fav.saved'));
  } catch (e) {
    console.warn('[ChaoticLorebooks] saveAsEntry write failed:', e);
    globalThis.toastr?.info?.(t('toast.fav.savedNoBook'));
  }
  return true;
}

// --- Mode-based selections for the injector ---
const enabledByMode = (mode) => getFavorites().filter((f) => f.enabled && f.mode === mode);

/** permanent → "★ Emphasize" block (after the main prompt, depth 1). */
export function renderForInjection(maxItems) {
  const items = enabledByMode('permanent').slice(-maxItems).map((f) => `- ${f.text}`);
  if (!items.length) return '';
  return `[★ Emphasize — the user marked these as important; weave them in naturally when relevant]\n${items.join('\n')}`;
}

/** chance → candidates to resurface as a memory (depth 3-4). */
export function getResurfaceCandidates() { return enabledByMode('chance'); }

/** relevant → items relevant to the scene by BM25 (🟢, no LLM; v1: AI decides). */
export function getRelevantInjection() {
  const items = enabledByMode('relevant');
  if (!items.length) return '';
  const docs = items.map((f) => ({ f, tokens: contentTokens(f.text) }));
  const ranked = bm25Rank(recentQueryTokens(), docs).filter((r) => r.score > 0).slice(0, 4);
  if (!ranked.length) return '';
  return `[Recalled — relevant to the current moment]\n${ranked.map((r) => `- ${r.doc.f.text}`).join('\n')}`;
}

/** Resurfacing candidates by BM25 (prefer quotes). Returns text or null. */
export function pickResurfaceText() {
  const items = enabledByMode('chance');
  if (!items.length) return null;
  const docs = items.map((f) => ({ f, tokens: contentTokens(f.text) }));
  let ranked = bm25Rank(recentQueryTokens(), docs).filter((r) => r.score > 0);
  if (!ranked.length) ranked = docs.map((d) => ({ doc: d, score: 0 })); // no matches — any
  const quotes = ranked.filter((r) => r.doc.f.kind === 'quote');
  const pool = quotes.length ? quotes : ranked;
  const top = pool.slice(0, 3);                       // a bit of randomness among the best
  return top[Math.floor(Math.random() * top.length)].doc.f.text;
}
