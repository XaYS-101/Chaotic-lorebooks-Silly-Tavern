// arc-segmenter.js — нарезка чата на «арки» + watermark + dirty-флаги (SPEC §0.3, §3b).
// Инкрементальность: обрабатываем только новый хвост; запечатанные арки не трогаем;
// существенная правка старого соо → dirty ТОЛЬКО той арки.
//
// Watermark «отстаёт от живого кончика на 1»: свайпаемая/правимая последняя реплика
// не попадает в память, пока юзер её не принял (settle-gate).
//
// Метки: 🟢 (нарезка по маркерам/cap — без LLM; «где резать на cap» — опц. джоба).

import { getSettings } from '../core/settings.js';
import { contentTokens, jaccard } from './text-relevance.js';
import { trace } from '../core/debug-trace.js';

const ARCS_KEY = 'chaoticLorebooks_arcs';
const WM_KEY = 'chaoticLorebooks_watermark';
const BASELINE_KEY = 'chaoticLorebooks_baseline';

// Маркеры границы сцены/арки.
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

// Снимок текста сообщений (в памяти) для гейта опечаток на правке.
const textSnap = new Map();

function tokHash(text) {
  // компактный «отпечаток» набора токенов арки для грубой инвалидации.
  const toks = contentTokens(text).sort();
  let h = 5381; const s = toks.join(' ');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Открытая (не запечатанная) арка; создаём, если её нет. */
export function getOpenArc() {
  const a = arcs();
  let open = a.find((x) => !x.sealed);
  if (!open) {
    // Пусто и есть baseline → форвард-арки стартуют ОТ baseline (исторический префикс
    // [0..baseline-1] оставляем неприкрытым, чтобы auto-hide его не трогал; backfill
    // позже сам нарежет его на арки sealRange'ом).
    const base = getBaseline();
    const prevEnd = a.length
      ? Math.max(...a.map((x) => x.end ?? -1))
      : (base != null ? base - 1 : -1);
    open = { id: a.length, start: prevEnd + 1, end: null, sealed: false, dirty: false, tokensHash: '', summaryGist: '' };
    a.push(open);
  }
  return open;
}

/** Текст пласта арки (по индексам сообщений). */
function slabText(start, end) {
  return chat().slice(start, end + 1).map((m) => `${m?.name}: ${m?.mes}`).join('\n');
}

/** Есть ли маркер границы в сообщениях диапазона (start..end включительно). */
function hasMarker(start, end) {
  const arc = getSettings().arc ?? {};
  const useMarkers = arc.useMarkers !== false;   // явная команда /cl-arc
  const useBreaks = arc.useSceneBreaks === true; // рисованные разделители (по умолч. выкл.)
  if (!useMarkers && !useBreaks) return false;
  for (let i = start; i <= end; i++) {
    const t = chat()[i]?.mes ?? '';
    if (useMarkers && ARC_MARKER_RE.test(t)) return true;
    if (useBreaks && SCENE_BREAK_RE.test(t)) return true;
  }
  return false;
}

/**
 * Вызывается на КАЖДОМ устоявшемся ходу (не свайпе). Обновляет watermark и,
 * если открытая арка дозрела (cap или маркер), запечатывает её.
 * Возвращает запечатанную арку (или null) — чтобы оркестратор поставил джобу
 * саммари и вызвал auto-hide.
 */
export async function onMessage() {
  const len = chat().length;
  if (len === 0) return null;

  // watermark = предпоследнее соо (отстаём от кончика на 1).
  const wm = Math.max(getWatermark(), len - 2);
  setWatermark(wm);

  // обновляем снимок текста для гейта опечаток (только до watermark — устоявшееся).
  for (let i = 0; i <= wm; i++) {
    if (!textSnap.has(i)) textSnap.set(i, chat()[i]?.mes ?? '');
  }

  const open = getOpenArc();
  if (open.start > wm) { await persist(); return null; }     // ещё нечего запечатывать

  const cap = Math.max(5, getSettings().arc?.capMessages ?? 40);
  const minLen = Math.max(2, getSettings().arc?.minMessages ?? 6);
  const lenInArc = wm - open.start + 1;
  const capReached = lenInArc >= cap;
  // Маркер запечатывает только арку не короче minLen (анти-короткие арки).
  const marker = lenInArc >= minLen && hasMarker(open.start, wm);

  if (!capReached && !marker) { await persist(); return null; }

  const sealed = await sealReady(capReached ? 'cap' : 'marker');
  await persist();
  return sealed;
}

/** Запечатать открытую арку до watermark. Возвращает арку или null. */
export async function sealReady(reason = 'manual') {
  const wm = getWatermark();
  const open = getOpenArc();
  if (open.start > wm) return null;

  open.end = wm;
  open.sealed = true;
  open.tokensHash = tokHash(slabText(open.start, open.end));
  trace('arc.seal', { arc: open.id, start: open.start, end: open.end, len: open.end - open.start + 1, reason });

  // следующая открытая арка начинается сразу после.
  const a = arcs();
  a.push({ id: a.length, start: wm + 1, end: null, sealed: false, dirty: false, tokensHash: '', summaryGist: '' });
  await persist();
  return open;
}

/** Пометить арку dirty (после существенной правки старого соо). */
export async function markDirty(arcId) {
  const arc = arcs().find((x) => x.id === arcId);
  if (arc && arc.sealed && !arc.dirty) { arc.dirty = true; await persist(); }
}

/** Арка, содержащая индекс соо (или null). */
function arcOfIndex(i) {
  return arcs().find((x) => x.sealed && i >= x.start && i <= (x.end ?? -1)) || null;
}

/**
 * Обработать правку соо (event MESSAGE_EDITED). Гейт опечаток: правка < threshold
 * слов → игнор (агентов не будим). Только существенная → арка dirty.
 */
export async function onEdit(index) {
  const i = Number(index);
  if (Number.isNaN(i)) return;
  const arc = arcOfIndex(i);
  if (!arc) { textSnap.set(i, chat()[i]?.mes ?? ''); return; }   // правка в живом окне — не память

  const oldText = textSnap.get(i);
  const newText = chat()[i]?.mes ?? '';
  textSnap.set(i, newText);
  if (oldText == null) return;            // старого текста не знаем (после рестарта) — не трогаем

  const threshold = getSettings().arc?.editDirtyThreshold ?? 0.10;
  const sim = jaccard(contentTokens(oldText), contentTokens(newText));
  if ((1 - sim) >= threshold) {
    arc.dirty = true;
    arc.tokensHash = tokHash(slabText(arc.start, arc.end));
    await persist();
    return arc;            // существенная правка → оркестратор откатит/переизвлечёт арку
  }
  return null;             // опечатка — арку не трогаем
}

/** Все запечатанные арки (для auto-hide / саммари). */
export function getSealedArcs() { return arcs().filter((x) => x.sealed); }

/** Арка по id (или null). */
export function getArc(arcId) { return arcs().find((x) => x.id === arcId) || null; }

/** Текст пласта арки (start..end) — для саммари/извлечения. */
export function arcText(arcId) {
  const a = getArc(arcId);
  if (!a || a.start == null || a.end == null) return '';
  return slabText(a.start, a.end);
}

/** Записать огрызок-саммари арки (arc-summary, после обработки). */
export async function setSummaryGist(arcId, gist) {
  const a = getArc(arcId);
  if (!a) return false;
  a.summaryGist = String(gist ?? '');
  a.dirty = false;            // обработана начисто
  await persist();
  return true;
}

/**
 * Записать значимость арки 0..1 (deep-extractor, Фаза C). Читают UI-бейдж и
 * решение об авто-пине. Некорректное → 0.5. Идемпотентно.
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
 * Подогнать унаследованные арки к длине ветки чата (branch-guard, после форка).
 * Ветка усечена в точке форка → арки, начинающиеся за концом, описывают «будущее»
 * родителя, которого тут нет: их выкидываем; арку, перекрывающую границу, метим
 * dirty (переизвлечётся начисто); watermark прижимаем к новому концу.
 * Best-effort, защищённо. Возвращает число удалённых арок.
 */
export async function reconcileArcsToChat() {
  try {
    const meta = ctx().chatMetadata;
    if (!meta || !Array.isArray(meta[ARCS_KEY])) return 0;
    const last = chat().length - 1;          // индекс последнего соо ветки
    const before = meta[ARCS_KEY].length;
    // Выкинуть арки, целиком лежащие за концом ветки.
    meta[ARCS_KEY] = meta[ARCS_KEY].filter((a) => (a.start ?? 0) <= last);
    for (const a of meta[ARCS_KEY]) {
      if (a.sealed && (a.end ?? -1) > last) {
        a.end = last;                        // обрезать по концу ветки
        a.dirty = true;                      // содержимое изменилось → переизвлечь
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

/** Сброс снимка при смене чата (метаданные арок — свои на чат). */
export function reset() { textSnap.clear(); }

// ===== Backfill: поздно-включённый чат =====

/**
 * Первый контакт с уже существующим чатом: если расширение никогда не видело
 * этот чат (watermark отсутствует) И длина чата > threshold — садим baseline,
 * чтобы getOpenArc стартовал с baseline, а исторический префикс [0..baseline-1]
 * остался уцелевшим под backfill (мега-арки и слепого auto-hide не будет).
 * Идемпотентно: повторный вызов после baseline уже стоит — no-op.
 * Возвращает true, если что-то посадили.
 */
export async function seedBaselineIfNeeded(threshold = 10) {
  const meta = ctx().chatMetadata;
  if (!meta) return false;
  // Уже знаком? — выходим.
  if (meta[WM_KEY] != null || meta[BASELINE_KEY] != null) return false;
  const len = chat().length;
  if (len <= threshold) return false;      // короткий чат → старое поведение
  setWatermark(len - 2);
  setBaseline(len);
  await persist();
  return true;
}

/**
 * Сколько сообщений в [0..baseline-1] ещё НЕ покрыты sealed-аркой.
 * Возвращает 0, если baseline не садился или префикс уже покрыт.
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

/** id для следующей арки — уникальный (выше всех существующих). */
function nextArcId() {
  const a = arcs();
  return a.length ? Math.max(...a.map((x) => Number(x.id) || 0)) + 1 : 0;
}

/**
 * Запечатать диапазон [start..end] как готовую sealed-арку (для backfill'а
 * исторического префикса). Открытую форвард-арку не трогаем.
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
 * Нарезать неприкрытый префикс [0..baseline-1] на запечатанные арки по capMessages.
 * Самую раннюю помечаем foundation:true. Идемпотентно: если префикс уже покрыт — [].
 * Возвращает массив id новосозданных арок.
 */
export async function backfillArcs() {
  const base = getBaseline();
  if (base == null || base <= 0) return [];
  const cap = Math.max(5, getSettings().arc?.capMessages ?? 40);

  // Найти уже покрытые диапазоны в [0..base-1], чтобы режемое было только дырами.
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
