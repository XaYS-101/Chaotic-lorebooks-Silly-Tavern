// backfill.js — one-time "catch-up" for chats where the extension was enabled late.
//
// Behavior: on first contact with a chat longer than backfill.threshold, seedBaseline
// sets chatMetadata.chaoticLorebooks_baseline = len and watermark = len-2 — forward
// arcs start from baseline, and the historical prefix [0..baseline-1] stays uncovered
// (auto-hide leaves it alone; no mega-arc and no blind hiding of history).
//
// The user can then "process" the prefix in one of two modes:
//   Full  — cut sealed arcs and run cheap AI (gist+quotes+triples+entries);
//   Light — cut + auto-hide only; no LLM.
//
// Backfill works with Balanced/Lite via a temporary chatMetadata.backfillActive, which
// job-queue.drain and arc-summary also honor (see §3 in the plan).

import { getSettings } from '../core/settings.js';
import { getBaseline, uncoveredPrefixLen, backfillArcs, getSealedArcs, getArc } from './arc-segmenter.js';
import { enqueue, setBackfillActive, onQueueDrained } from '../core/job-queue.js';
import { maintain as autoHideMaintain } from './auto-hide.js';
import { getActive as getActiveRecollections } from './recollection.js';
import { log as logActivity } from './activity-log.js';
import { t } from '../core/i18n.js';

/** Log the sealing of a backfill arc to activity (for the timeline). */
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

/** Does any forward extension memory already exist (arc summaries / gists)? */
function hasExtensionMemory() {
  try {
    if (getSealedArcs().some((a) => a.summaryGist)) return true;
  } catch { /* ok */ }
  try {
    if (getActiveRecollections().length > 0) return true;
  } catch { /* ok */ }
  return false;
}

/** Is one-time backfill available now? Derived from state — no "declined" flag. */
export function backfillAvailable() {
  const s = getSettings();
  const threshold = s.backfill?.threshold ?? 10;
  const len = chat().length;
  if (len - 2 <= threshold) return false;
  if (uncoveredPrefixLen() <= 0) return false;
  if (hasExtensionMemory()) return false;
  return true;
}

/** Summary for UI/banner: how many messages wait, plus estimated arcs and LLM calls. */
export function getBackfillInfo() {
  const cap = Math.max(5, getSettings().arc?.capMessages ?? 40);
  const count = uncoveredPrefixLen();
  const arcsEstimate = count > 0 ? Math.max(1, Math.ceil(count / cap)) : 0;
  return { count, arcsEstimate, callsEstimate: arcsEstimate };
}

/**
 * Run backfill in the chosen mode.
 * mode: 'full' (cheap-AI) | 'light' (no LLM)
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
  logBackfillSeals(ids);            // timeline: mark the cut slabs
  if (mode === 'light') {
    await autoHideMaintain();
    globalThis.toastr?.success?.(t('toast.backfillLight', { n: ids.length }));
    return true;
  }
  // Full: enable backfillActive (so drain runs even in Balanced/Lite), enqueue
  // arc-extracts, and listen for queue drain — then run auto-hide and the toast.
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

/** Popup with two radios (Full / Light), Full by default. */
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
 * Called from CHAT_CHANGED AFTER seedBaselineIfNeeded: shows the modal once per chat
 * (flag stored in chatMetadata). The drawer banner and the settings button always
 * derive from backfillAvailable(), not from "shown/not shown".
 */
export async function maybeOfferBackfill() {
  try {
    if (!backfillAvailable()) return;
    const meta = ctx().chatMetadata;
    if (!meta) return;
    if (meta[PROMPT_SHOWN_KEY]) return;          // modal already shown in this chat
    meta[PROMPT_SHOWN_KEY] = true;
    try { await ctx().saveMetadata(); } catch { /* ok */ }
    // Small delay so ST's UI has time to render.
    setTimeout(() => { runBackfillFlow().catch(warn); }, 400);
  } catch (e) { warn(e); }
}

const warn = (e) => console.warn('[ChaoticLorebooks] backfill:', e);
