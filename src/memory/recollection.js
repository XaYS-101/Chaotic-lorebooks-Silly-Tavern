// recollection.js — ярус 2 «воспоминания» (Фаза B).
// Сжатые огрызки запечатанных арок + ссылки в граф + 2-4 дословные voiceQuotes.
// Живёт в chatMetadata (свой на чат). Забывание = active=false (естественное
// затухание по maxGists, ручной тумблер, bulk по арке).
//
// Инъекция — чистый код (🟢), без LLM: активные огрызки под бюджет токенов.
// Сами огрызки рождает arc-summary (🟡) из job-queue.
//
// Метки: 🟢. Зависит только от настроек и метаданных.

import { getSettings } from '../core/settings.js';

const KEY = 'chaoticLorebooks_recollection';

function ctx() { return SillyTavern.getContext(); }
function store() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[KEY])) meta[KEY] = [];
  return meta[KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

/** Все огрызки (для UI). */
export function getGists() { return store(); }

/** Активные огрызки (для инъекции). */
export function getActive() { return store().filter((g) => g.active !== false); }

/**
 * Добавить огрызок арки. Дедуп по arcId: повторная обработка арки обновляет, не плодит.
 * `significance` (0..1, дефолт 0.5) — приоритет при затухании: важные держим,
 * филлер гаснет первым. Проставляет deep-extractor; без него — нейтральные 0.5.
 * @param {{gist, graphRefs?, voiceQuotes?, arcId, significance?}} g
 */
export async function addGist(g) {
  if (!g?.gist) return null;
  const arr = store();
  const id = `r_${g.arcId ?? 'x'}_${Date.now().toString(36)}`;
  const quotesCap = Math.max(0, getSettings().recollection?.voiceQuotesPerArc ?? 3);
  const rec = {
    id,
    gist: String(g.gist),
    graphRefs: Array.isArray(g.graphRefs) ? g.graphRefs.slice(0, 12) : [],
    voiceQuotes: Array.isArray(g.voiceQuotes) ? g.voiceQuotes.slice(0, quotesCap) : [],
    active: true,
    arcId: g.arcId ?? null,
    significance: clampSig(g.significance),
    addedAt: Date.now(),
  };
  // если для этой арки уже есть огрызок — заменяем (арка обрабатывается один раз).
  const existIdx = arr.findIndex((x) => x.arcId != null && x.arcId === rec.arcId);
  if (existIdx >= 0) arr.splice(existIdx, 1, rec); else arr.push(rec);

  decayOverflow(arr);
  await persist();
  return id;
}

/** Значимость в [0..1]; некорректное → нейтральные 0.5. */
function clampSig(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Естественное затухание: держим не больше maxGists АКТИВНЫХ. Гасим (active=false,
 * не удаляем — recoverable) сначала наименее значимые, при равной значимости — старые.
 * Так «филлер» уходит раньше важных арок.
 */
function decayOverflow(arr) {
  const max = Math.max(1, getSettings().recollection?.maxGists ?? 12);
  const actives = arr.filter((x) => x.active !== false);
  if (actives.length <= max) return;
  actives.sort((a, b) => (clampSig(a.significance) - clampSig(b.significance))
    || ((a.addedAt ?? 0) - (b.addedAt ?? 0)));
  for (let i = 0; i < actives.length - max; i++) actives[i].active = false;
}

/**
 * Проставить значимость огрызку арки (deep-extractor, после оценки). Может
 * пере-затухать: новый филлер мог вытеснить кого-то менее значимого. Идемпотентно.
 */
export async function setSignificance(arcId, score) {
  const arr = store();
  const r = arr.find((x) => x.arcId != null && x.arcId === arcId);
  if (!r) return false;
  r.significance = clampSig(score);
  decayOverflow(arr);
  await persist();
  return true;
}

/** Тумблер active одного огрызка. */
export async function setActive(id, active) {
  const r = store().find((x) => x.id === id);
  if (!r) return false;
  r.active = !!active;
  await persist();
  return true;
}

/** Bulk: включить/выключить все огрызки арки («забыл эту арку» / «вспомнил»). */
export async function bulkSetArc(arcId, active) {
  let changed = false;
  for (const r of store()) if (r.arcId === arcId) { r.active = !!active; changed = true; }
  if (changed) await persist();
  return changed;
}

/** Удалить огрызок насовсем. */
export async function removeGist(id) {
  const arr = store();
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) return false;
  arr.splice(i, 1);
  await persist();
  return true;
}

/**
 * Собрать инъекцию яруса 2 под бюджет токенов (🟢, без LLM).
 * Огрызки (по возрастанию арки) + дословные voiceQuotes. Возвращает строку или ''.
 */
export async function renderForInjection(budget) {
  const s = getSettings();
  if (s.recollection?.enabled === false) return '';
  const actives = getActive().slice().sort((a, b) => (a.arcId ?? 0) - (b.arcId ?? 0));
  if (!actives.length) return '';

  const lines = [];
  for (const r of actives) {
    lines.push(`- ${r.gist}`);
    for (const q of r.voiceQuotes || []) lines.push(`  » ${q}`);
  }
  const body = lines.join('\n');
  const tokenBudget = budget ?? s.recollection?.budget ?? 500;
  const trimmed = await trimToBudget(body, tokenBudget);
  if (!trimmed) return '';
  return `[Recollections — condensed memory of earlier scenes]\n${trimmed}`;
}

/** Подрезать текст под бюджет токенов (точный счётчик ST при наличии, иначе ~4 симв/токен). */
async function trimToBudget(text, tokenBudget) {
  const lines = String(text).split('\n');
  const c = ctx();
  if (typeof c.getTokenCountAsync === 'function') {
    let out = [];
    for (const l of lines) {
      const candidate = [...out, l].join('\n');
      // считаем нарастающим итогом; дорого, но строк мало
      // eslint-disable-next-line no-await-in-loop
      const n = await c.getTokenCountAsync(candidate, 0).catch(() => candidate.length / 4);
      if (n > tokenBudget) break;
      out.push(l);
    }
    return out.join('\n');
  }
  const charBudget = Math.max(120, tokenBudget * 4);
  if (text.length <= charBudget) return text;
  let out = '';
  for (const l of lines) { if (out.length + l.length + 1 > charBudget) break; out += (out ? '\n' : '') + l; }
  return out;
}
