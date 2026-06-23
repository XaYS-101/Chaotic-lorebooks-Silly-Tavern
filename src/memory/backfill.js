// backfill.js — разовый «catch-up» для чатов, где расширение включили поздно.
//
// Поведение: при первом контакте с чатом длиной > backfill.threshold seedBaseline
// сажает chatMetadata.chaoticLorebooks_baseline = len и watermark = len-2 —
// форвард-арки стартуют с baseline, исторический префикс [0..baseline-1] остаётся
// неприкрытым (auto-hide его не трогает; никакой мега-арки и слепого скрытия истории).
//
// Затем юзер может «процессить» префикс одним из двух режимов:
//   Full  — нарезать sealed-арки и прогнать дешевую ИИ (gist+цитаты+триплеты+энтри);
//   Light — только нарезать + auto-hide; без LLM.
//
// Backfill совместим с Balanced/Lite через временный chatMetadata.backfillActive,
// который job-queue.drain и arc-summary тоже чтят (см. §3 в плане).

import { getSettings } from '../core/settings.js';
import { getBaseline, uncoveredPrefixLen, backfillArcs, getSealedArcs, getArc } from './arc-segmenter.js';
import { enqueue, setBackfillActive, onQueueDrained } from '../core/job-queue.js';
import { maintain as autoHideMaintain } from './auto-hide.js';
import { getActive as getActiveRecollections } from './recollection.js';
import { log as logActivity } from './activity-log.js';
import { t } from '../core/i18n.js';

/** Записать в активность факт нарезки backfill-арки (для таймлайна). */
function logBackfillSeals(ids) {
  for (const id of ids) {
    const a = getArc(id);
    logActivity({ kind: 'arc-seal', arcId: id, detail: a ? `backfill #${a.start}–${a.end}` : 'backfill' })
      .catch(() => {});
  }
}

const PROMPT_SHOWN_KEY = 'chaoticLorebooks_backfillPromptShown';

function ctx() { return SillyTavern.getContext(); }
function chat() { return ctx().chat ?? []; }

/** Есть ли уже какая-то «вперёд» память расширения (саммари арок / огрызки). */
function hasExtensionMemory() {
  try {
    if (getSealedArcs().some((a) => a.summaryGist)) return true;
  } catch { /* ok */ }
  try {
    if (getActiveRecollections().length > 0) return true;
  } catch { /* ok */ }
  return false;
}

/** Доступен ли разовый backfill сейчас? Деривируется из стейта — без флага «отказался». */
export function backfillAvailable() {
  const s = getSettings();
  const threshold = s.backfill?.threshold ?? 10;
  const len = chat().length;
  if (len - 2 <= threshold) return false;
  if (uncoveredPrefixLen() <= 0) return false;
  if (hasExtensionMemory()) return false;
  return true;
}

/** Сводка для UI/banner: сколько соо ждут, сколько арок и LLM-вызовов прикинуть. */
export function getBackfillInfo() {
  const cap = Math.max(5, getSettings().arc?.capMessages ?? 40);
  const count = uncoveredPrefixLen();
  const arcsEstimate = count > 0 ? Math.max(1, Math.ceil(count / cap)) : 0;
  return { count, arcsEstimate, callsEstimate: arcsEstimate };
}

/**
 * Прогнать backfill в выбранном режиме.
 * mode: 'full' (cheap-AI) | 'light' (без LLM)
 */
export async function runBackfill(mode = 'full') {
  if (getBaseline() == null) {
    globalThis.toastr?.info?.(t('toast.backfillNone'));
    return false;
  }
  if (uncoveredPrefixLen() <= 0) {
    globalThis.toastr?.info?.(t('toast.backfillNone'));
    return false;
  }
  const ids = await backfillArcs();
  if (!ids.length) {
    globalThis.toastr?.info?.(t('toast.backfillNone'));
    return false;
  }
  logBackfillSeals(ids);            // таймлайн: отметить нарезанные пласты
  if (mode === 'light') {
    await autoHideMaintain();
    globalThis.toastr?.success?.(t('toast.backfillLight', { n: ids.length }));
    return true;
  }
  // Full: включаем backfillActive (так drain пройдёт и в Balanced/Lite), ставим
  // arc-extract'ы и слушаем дренаж очереди — тогда запустим auto-hide и тост.
  await setBackfillActive(true);
  onQueueDrained(async () => {
    try { await autoHideMaintain(); } catch (e) { console.warn('[ChaoticLorebooks] backfill autoHide:', e); }
    globalThis.toastr?.success?.(t('toast.backfillDone', { n: ids.length }));
  });
  for (const id of ids) {
    await enqueue('arc-extract', { arcId: id }).catch(warn);
  }
  globalThis.toastr?.success?.(t('toast.backfillQueued', { n: ids.length }));
  return true;
}

/** Попап с двумя радио (Full / Light), Full по умолчанию. */
export async function runBackfillFlow() {
  if (!backfillAvailable()) {
    globalThis.toastr?.info?.(t('toast.backfillNone'));
    return false;
  }
  const c = ctx();
  const info = getBackfillInfo();
  const wrap = document.createElement('div');
  wrap.className = 'cl-backfill-popup';
  wrap.innerHTML = `
    <h3>${t('backfill.popup.title')}</h3>
    <p>${t('backfill.popup.body', { n: info.count, arcs: info.arcsEstimate })}</p>
    <label class="cl-choose-row">
      <input type="radio" name="cl-bf-mode" value="full" checked>
      <span><b>${t('backfill.popup.full')}</b></span>
    </label>
    <label class="cl-choose-row">
      <input type="radio" name="cl-bf-mode" value="light">
      <span>${t('backfill.popup.light')}</span>
    </label>
    <p class="cl-backfill-warn">${t('backfill.popup.warn')}</p>`;

  const POPUP_TYPE = c.POPUP_TYPE ?? {};
  const POPUP_RESULT = c.POPUP_RESULT ?? {};
  let res;
  try {
    res = await c.callGenericPopup(wrap, POPUP_TYPE.CONFIRM ?? 2, '', {
      okButton: t('backfill.popup.process'),
      cancelButton: t('backfill.popup.notNow'),
    });
  } catch (e) {
    console.warn('[ChaoticLorebooks] backfill popup failed:', e);
    return false;
  }
  const affirmative = POPUP_RESULT.AFFIRMATIVE ?? 1;
  if (res !== affirmative && res !== true) return false;
  const choice = wrap.querySelector('input[name="cl-bf-mode"]:checked')?.value || 'full';
  return await runBackfill(choice);
}

/**
 * Вызывается из CHAT_CHANGED ПОСЛЕ seedBaselineIfNeeded: один раз на чат
 * показывает модал (флаг хранится в chatMetadata). Баннер в дровере и кнопка
 * в настройках всегда деривируются из backfillAvailable(), не из «показано/нет».
 */
export async function maybeOfferBackfill() {
  try {
    if (!backfillAvailable()) return;
    const meta = ctx().chatMetadata;
    if (!meta) return;
    if (meta[PROMPT_SHOWN_KEY]) return;          // модал уже показывали в этом чате
    meta[PROMPT_SHOWN_KEY] = true;
    try { await ctx().saveMetadata(); } catch { /* ok */ }
    // Лёгкая задержка, чтобы UI ST успел отрисоваться.
    setTimeout(() => { runBackfillFlow().catch(warn); }, 400);
  } catch (e) { warn(e); }
}

const warn = (e) => console.warn('[ChaoticLorebooks] backfill:', e);
