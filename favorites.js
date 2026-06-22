// favorites.js — сохранённые соо (★) и ЦИТАТЫ (части соо). Единая модель с
// РЕЖИМОМ ИНЪЕКЦИИ на каждый пункт. Хранение в chatMetadata. Всё 🟢
// (кроме →lorebook и mode='relevant'+AI — помечено).
//
// Модель пункта:
//   { id, mesIndex, text, kind:'message'|'quote',
//     mode:'permanent'|'chance'|'relevant',   // как попадает в инъекцию
//     enabled, pinned, addedAt }
//   permanent — всегда после основного промпта (как акцент)
//   chance    — с шансом всплывает как воспоминание (глубина 3-4)
//   relevant  — инжектится, когда релевантно сцене (алгоритм; v1: решает ИИ)

import { getSettings } from './settings.js';
import { contentTokens, bm25Rank } from './text-relevance.js';
import { t } from './i18n.js';

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

/** ★ на ВСЁ сообщение (toggle). Режим по умолчанию permanent. */
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

/** Добавить ВЫДЕЛЕННУЮ цитату (часть соо). Аддитивно. Режим по умолчанию из настроек. */
export async function addQuote(mesIndex, text, mode) {
  if (!text?.trim()) return;
  const def = getSettings().quotes?.defaultMode || 'chance';
  getFavorites().push(mk(mesIndex, text, 'quote', mode || def));
  await persist();
}

function mk(mesIndex, text, kind, mode) {
  return {
    id: `${kind[0]}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    mesIndex, text: String(text).trim().slice(0, 500),
    kind, mode, enabled: true, pinned: false, addedAt: Date.now(),
  };
}

// --- CRUD редактора ---
export async function editText(id, text) { const f = find(id); if (f) { f.text = text; await persist(); } }
export async function setEnabled(id, on) { const f = find(id); if (f) { f.enabled = !!on; await persist(); } }
export async function setPinned(id, on) { const f = find(id); if (f) { f.pinned = !!on; await persist(); } }
export async function setMode(id, mode) { const f = find(id); if (f) { f.mode = mode; await persist(); } }
export async function removeFavorite(id) {
  const favs = getFavorites(); const i = favs.findIndex((f) => f.id === id);
  if (i >= 0) { favs.splice(i, 1); await persist(); }
}
function find(id) { return getFavorites().find((x) => x.id === id); }

/** Промоут в постоянную энтри лорбука (ярус «вечное»). ⚠FLAG: через lorebook-writer (Фаза 4). */
export async function saveAsEntry(id) {
  const f = find(id); if (!f) return false;
  f.pinned = true; f.enabled = true; f.mode = 'permanent';
  await persist();
  // Записываем как закреплённую (origin=user) энтри через единственную очередь.
  try {
    const { enqueueWrite } = await import('./lorebook-writer.js');
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

// --- Выборки по режиму для инъектора ---
const enabledByMode = (mode) => getFavorites().filter((f) => f.enabled && f.mode === mode);

/** permanent → блок «★ Emphasize» (после основного промпта, глубина 1). */
export function renderForInjection(maxItems) {
  const items = enabledByMode('permanent').slice(-maxItems).map((f) => `- ${f.text}`);
  if (!items.length) return '';
  return `[★ Emphasize — the user marked these as important; weave them in naturally when relevant]\n${items.join('\n')}`;
}

/** chance → кандидаты на всплытие как воспоминание (глубина 3-4). */
export function getResurfaceCandidates() { return enabledByMode('chance'); }

/** relevant → пункты, релевантные сцене по BM25 (🟢, без LLM; v1: решает ИИ). */
export function getRelevantInjection() {
  const items = enabledByMode('relevant');
  if (!items.length) return '';
  const docs = items.map((f) => ({ f, tokens: contentTokens(f.text) }));
  const ranked = bm25Rank(recentQueryTokens(), docs).filter((r) => r.score > 0).slice(0, 4);
  if (!ranked.length) return '';
  return `[Recalled — relevant to the current moment]\n${ranked.map((r) => `- ${r.doc.f.text}`).join('\n')}`;
}

/** Кандидаты для ресёрфинга по BM25 (предпочитаем цитаты). Возвращает текст или null. */
export function pickResurfaceText() {
  const items = enabledByMode('chance');
  if (!items.length) return null;
  const docs = items.map((f) => ({ f, tokens: contentTokens(f.text) }));
  let ranked = bm25Rank(recentQueryTokens(), docs).filter((r) => r.score > 0);
  if (!ranked.length) ranked = docs.map((d) => ({ doc: d, score: 0 })); // нет совпадений — любой
  const quotes = ranked.filter((r) => r.doc.f.kind === 'quote');
  const pool = quotes.length ? quotes : ranked;
  const top = pool.slice(0, 3);                       // немного рандома среди лучших
  return top[Math.floor(Math.random() * top.length)].doc.f.text;
}
