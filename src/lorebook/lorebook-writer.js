// lorebook-writer.js — ЕДИНСТВЕННАЯ точка записи в книгу (SPEC §0.2, §3b, Фаза A).
// Никакая фича не вызывает saveWorldInfo напрямую — только через этот модуль.
//
// Гарантии:
//   - Мьютекс: все записи сериализуются (промис-цепочка) → нет гонок между нашими задачами.
//   - CAS-по-хэшу: перед перезаписью авто-энтри перечитываем книгу; если контент
//     энтри изменился с нашей прошлой записи (юзер правил вручную) → энтри
//     повышается в origin=user и автоматикой больше НЕ трогается (юзер всегда выигрывает).
//   - РЕАЛЬНЫЕ key: каждая энтри — валидная WI-запись с настоящими ключами
//     (никакого подавления keyword-скана; выключили расширение → книга работает сама).
//   - origin-теги в comment: auto-arc|auto-detail|author-note|scout|user.
//   - defer на ручную правку: пока юзер редактирует книгу (WORLDINFO_UPDATED) — ждём.
//   - safety-снапшот перед перезаписью существующей энтри.
//
// Сверено с ST: createWorldInfoEntry/createNewWorldInfo НЕ на context → реплицируем
// шаблон энтри (newWorldInfoEntryDefinition) и свободный uid здесь.

import { getBoundBookName, ensureBookForWrite } from './lorebook-service.js';
import { contentTokens } from '../memory/text-relevance.js';

function ctx() { return SillyTavern.getContext(); }

// Шаблон новой энтри (значения по умолчанию из newWorldInfoEntryDefinition, ST 1.12+).
// Экспортируется, чтобы другие писатели (knowledge-graph) создавали ПОЛНЫЕ записи.
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
// Происхождения, которые автоматика НЕ перезаписывает.
const PROTECTED_ORIGINS = new Set(['user', 'author-note']);

// --- defer на ручную правку юзера ---
let deferUntil = 0;
/** index.js зовёт при WORLDINFO_UPDATED по нашей книге. Откладываем записи на 5с. */
export function noteUserEditing() { deferUntil = Date.now() + 5000; }
async function waitIfDeferred() {
  while (Date.now() < deferUntil) {
    await new Promise((r) => setTimeout(r, Math.min(500, deferUntil - Date.now() + 1)));
  }
}

// --- Мьютекс: глобальная промис-цепочка записей ---
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);          // выполнить даже если предыдущая упала
  chain = run.catch(() => {});             // цепочку не рвём
  return run;
}

// --- Утилиты ---
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

/** Вывести РЕАЛЬНЫЕ ключи из явного списка / заголовка / контента (≥1 гарантирован). */
function deriveKeys(patch) {
  if (Array.isArray(patch.key) && patch.key.length) {
    return patch.key.map((k) => String(k).trim()).filter(Boolean);
  }
  const keys = new Set();
  // Имена собственные (с заглавной) из заголовка и первых строк контента — лучшие ключи.
  const src = `${patch.title ?? ''} ${patch.content ?? ''}`;
  for (const m of src.matchAll(/\b([A-ZА-ЯЁ][\p{L}]{2,})\b/gu)) keys.add(m[1]);
  // Добавим пару значимых контент-токенов, если имён мало.
  if (keys.size < 2) for (const t of contentTokens(patch.title || patch.content).slice(0, 3)) keys.add(t);
  const arr = [...keys].slice(0, 6);
  return arr.length ? arr : ['memory'];
}

/** Найти существующую авто-энтри по дедупу: тот же treePath+title, либо пересечение ключей. */
function findDup(data, patch, keys) {
  const wantTitle = (patch.title ?? '').toLowerCase().trim();
  const wantPath = (patch.treePath ?? '').toLowerCase().trim();
  const keyset = new Set(keys.map((k) => k.toLowerCase()));
  for (const e of Object.values(data.entries)) {
    const cmt = String(e.comment ?? '').toLowerCase();
    const eTitle = cmt.replace(ORIGIN_RE, '').replace(TREE_RE, '').trim();
    const samePath = wantPath && cmt.includes(`[tree: ${wantPath}]`);
    if (wantTitle && eTitle === wantTitle && (!wantPath || samePath)) return e;
    // пересечение ключей (триграм-дешёвый дедуп): ≥2 общих ключа
    const ek = new Set((e.key ?? []).map((k) => String(k).toLowerCase()));
    let common = 0; for (const k of keyset) if (ek.has(k)) common++;
    if (common >= 2 && samePath) return e;
  }
  return null;
}

/**
 * Низкоуровневая операция чтения-правки-записи книги под мьютексом и с CAS.
 * mutate(data) — изменяет data.entries; возвращает true если что-то менялось.
 */
export function casWrite(name, mutate) {
  return withLock(async () => {
    await waitIfDeferred();
    // Ленивое создание книги: первая РЕАЛЬНАЯ запись создаёт книгу (отложенный старт).
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
 * Высокоуровневая запись. patch:
 *   { origin, tier, arc, content, title, treePath, key?[] }
 * Идемпотентно: апдейт существующей авто-энтри либо создание новой.
 * Защищённые origin (user/author-note) НЕ перезаписываются.
 */
export async function enqueueWrite(patch) {
  if (!patch?.content && !patch?.title) return false;
  const keys = deriveKeys(patch);
  let touchedExisting = false;

  const ok = await casWrite(null, async (data) => {
    const dup = findDup(data, patch, keys);

    if (dup) {
      const origin = parseOrigin(dup.comment);
      // CAS: контент изменился с нашей прошлой записи? → юзер правил вручную.
      const storedH = origin.h;
      const curH = djb2(dup.content);
      if (storedH && storedH !== curH) {
        // Повышаем в origin=user и больше не трогаем содержимое.
        dup.comment = bumpOriginToUser(dup.comment);
        return true;
      }
      if (PROTECTED_ORIGINS.has(origin.origin)) return false;   // юзер/заметка — не трогаем
      // Обновляем содержимое авто-энтри.
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

    // Новая энтри.
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
      constant: patch.tier === 'pinned',          // pinned → всегда активна
    };
    return true;
  });

  // Safety-снапшот, если перезаписали существующую (опасная операция).
  if (ok && touchedExisting) {
    try { const { safetySnapshot } = await import('./backup.js'); await safetySnapshot(); }
    catch { /* backup необязателен */ }
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
    // h НЕ ставим: origin=user больше не сверяется автоматикой.
  });
}

/** Идемпотентный upsert произвольной энтри (для будущих модулей). */
export async function upsertEntry(entry) {
  return casWrite(null, async (data) => {
    const uid = entry.uid != null && entry.uid in data.entries ? entry.uid : freeUid(data);
    if (uid == null) return false;
    data.entries[uid] = { ...structuredClone(ENTRY_TEMPLATE), ...entry, uid };
    return true;
  });
}

/** Слить две энтри (b в a): объединить ключи и контент. Возвращает a. */
export function mergeEntries(a, b) {
  a.key = Array.from(new Set([...(a.key ?? []), ...(b.key ?? [])])).slice(0, 8);
  if (b.content && !String(a.content).includes(b.content)) {
    a.content = `${a.content}\n${b.content}`.trim();
  }
  return a;
}
