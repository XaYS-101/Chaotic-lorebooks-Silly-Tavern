// auto-hide.js — держит активное окно маленьким, скрывая старые соо ПЛАСТАМИ по арке
// (SPEC §4b, §9b). Скрытие = флаг is_system (НЕ удаление) → соо выпадает из coreChat
// (сверено: script.js coreChat = chat.filter(x => !x.is_system)). Полностью обратимо.
//
// Железные гарантии:
//   - прячем ТОЛЬКО после захвата в память: i ≤ watermark и арка запечатана;
//   - режем целым пластом запечатанной арки (а не по одному соо);
//   - из НОВЕЙШЕГО скрываемого пласта оставляем keepTailFromSlab соо видимыми (мост);
//   - НЕ трогаем живой кончик (последние windowSize соо) и pinned-избранное;
//   - наш набор скрытых индексов трекается в метаданных → revealAll вернёт ровно их
//     (ручные /hide юзера не задеваем).
//
// Метки: 🟢 (без LLM; манипуляция флагом + DOM-атрибутом существующих .mes).

import { getSettings } from '../core/settings.js';
import { getSealedArcs } from './arc-segmenter.js';
import { getFavorites } from '../inject/favorites.js';

const HIDDEN_KEY = 'chaoticLorebooks_hidden';
const WM_KEY = 'chaoticLorebooks_watermark';

function ctx() { return SillyTavern.getContext(); }
function chat() { return ctx().chat ?? []; }
function watermark() { return ctx().chatMetadata?.[WM_KEY] ?? -1; }

function hiddenSet() {
  const meta = ctx().chatMetadata;
  if (!meta) return new Set();
  if (!Array.isArray(meta[HIDDEN_KEY])) meta[HIDDEN_KEY] = [];
  return new Set(meta[HIDDEN_KEY]);
}
function saveHidden(set) {
  const meta = ctx().chatMetadata;
  if (meta) meta[HIDDEN_KEY] = [...set].sort((a, b) => a - b);
}
async function persistMeta() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }
async function persistChat() { try { await ctx().saveChat?.(); } catch { /* no-op */ } }

function pinnedIndices() {
  const set = new Set();
  for (const f of getFavorites()) if (f.pinned && typeof f.mesIndex === 'number') set.add(f.mesIndex);
  return set;
}

/**
 * Соо принадлежит ST (системное / коммент / авторская заметка), а не нам?
 * ST метит такие is_system=true (+ класс .smallSysMes в DOM). Мы их НЕ трогаем:
 * иначе сняв is_system мы сорвём их стилизацию (баг «у заметок пропадает css»).
 * Наши собственные скрытые соо тоже is_system=true, но они в tracked — их различаем по set.
 */
function isForeignSystem(i, tracked) {
  if (tracked.has(i)) return false;        // это МЫ его спрятали — наше
  return !!chat()[i]?.is_system;           // is_system не наш → ST-овское (заметка/коммент/сис.)
}

/** Низкоуровнево: пометить соо скрытым/видимым (реплика hideChatMessageRange). */
function setHidden(i, hide) {
  const m = chat()[i];
  if (!m) return false;
  m.is_system = hide;
  const block = document.querySelector(`#chat .mes[mesid="${i}"]`);
  if (block) block.setAttribute('is_system', String(hide));
  return true;
}

/**
 * Поддержать активное окно: вычислить целевой набор скрытых индексов и применить
 * дифф. Дёшево; зовётся из injector перед сборкой и после запечатывания арки.
 */
export async function maintain() {
  const s = getSettings().autoHide ?? {};
  const tracked = hiddenSet();

  if (s.enabled === false) {
    if (tracked.size) await revealAll();     // выключили — вернуть всё, что прятали
    return;
  }

  const len = chat().length;
  const window = Math.max(2, s.windowSize ?? 12);
  const keepTail = Math.max(0, s.keepTailFromSlab ?? 2);
  const afterSummary = s.afterSummary !== false;   // дефолт: прятать только суммаризованное
  const scope = s.scope === 'newest' ? 'newest' : 'slab';
  const wm = watermark();
  const visibleFloor = len - window;         // индексы ≥ floor — живое окно (ВСЕГДА видимы)

  const pinned = pinnedIndices();

  // Кандидаты-арки: запечатанные, захваченные (end ≤ watermark) и — если afterSummary —
  // уже суммаризованные (есть summaryGist), чтобы скрытие не теряло контекст без замены.
  let arcs = getSealedArcs()
    .filter((a) => a.end != null && a.end <= wm)
    .filter((a) => !afterSummary || (a.summaryGist && String(a.summaryGist).trim()))
    .sort((a, b) => a.start - b.start);
  if (!arcs.length) { if (tracked.size) await revealAll(); return; }

  const newestEnd = Math.max(...arcs.map((a) => a.end));
  // scope 'newest' → прячем только новейший суммаризованный пласт; 'slab' → все кандидаты.
  if (scope === 'newest') arcs = arcs.filter((a) => a.end === newestEnd);

  // Целевой набор скрытых индексов: всё внутри арок, но НЕ в живом окне.
  const target = new Set();
  for (const a of arcs) {
    // из новейшего пласта оставляем keepTail соо видимыми (мост к сырому окну).
    const hideEnd = a.end === newestEnd ? a.end - keepTail : a.end;
    for (let i = a.start; i <= hideEnd; i++) {
      if (i >= visibleFloor) continue;       // в живом окне — не трогаем
      if (pinned.has(i)) continue;           // pinned — иммунен
      if (isForeignSystem(i, tracked)) continue; // авторская заметка / ST-системное — не трогаем
      target.add(i);
    }
  }

  // Дифф: спрятать новые, показать выпавшие из таргета (например арка стала dirty/окно сдвинулось назад).
  let changed = false;
  for (const i of target) if (!tracked.has(i)) { if (setHidden(i, true)) { tracked.add(i); changed = true; } }
  for (const i of [...tracked]) {
    if (!target.has(i)) { setHidden(i, false); tracked.delete(i); changed = true; }
  }

  if (changed) { saveHidden(tracked); await persistMeta(); await persistChat(); }
}

/** Скрыть конкретную арку как пласт (ручной триггер). */
export async function hideArcSlab(arcId) {
  const arc = getSealedArcs().find((a) => a.id === arcId);
  if (!arc || arc.end == null) return;
  const tracked = hiddenSet();
  const pinned = pinnedIndices();
  let changed = false;
  for (let i = arc.start; i <= arc.end; i++) {
    if (pinned.has(i)) continue;
    if (isForeignSystem(i, tracked)) continue;   // авторская заметка / ST-системное — не трогаем
    if (setHidden(i, true)) { tracked.add(i); changed = true; }
  }
  if (changed) { saveHidden(tracked); await persistMeta(); await persistChat(); }
}

/** Показать всё, что МЫ скрывали (ручные /hide юзера не трогаем). */
export async function revealAll() {
  const tracked = hiddenSet();
  if (!tracked.size) return;
  for (const i of tracked) setHidden(i, false);
  saveHidden(new Set());
  await persistMeta();
  await persistChat();
}
