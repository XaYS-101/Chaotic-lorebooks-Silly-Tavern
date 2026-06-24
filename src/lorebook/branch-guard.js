// branch-guard.js — memory isolation on chat fork (SPEC §7). All 🟢.
//
// Problem: when ST branches a chat (branchChat → "… - Branch #N") it COPIES the
// parent's chat_metadata into the new chat — including the book binding
// (world_info) and all our state (chaoticLorebooks_*). The timelines diverge but
// SHARE one book: in autonomous mode the branch's background agent writes
// arcs/graph/memories into the PARENT's book, overwriting its memory with events
// that never happened there.
//
// Solution: on entering a fork, offer the branch its OWN book (copy → rebind).
// No LLM, all modes, idempotent, never asks twice for the same branch.
//
// Checked against ST (public/scripts/bookmarks.js, script.js):
//   - there is no dedicated branch event; a fork only emits CHAT_CHANGED on open.
//   - branch/checkpoint marker: chat_metadata.main_chat = parent chat name.
//   - on fork metadata = {...chat_metadata, ...{main_chat}} → world_info inherited.

import { getSettings, saveSettings } from '../core/settings.js';
import { getBoundBookName, forkBook, deriveBranchBookName } from './lorebook-service.js';
import { reconcileArcsToChat } from '../memory/arc-segmenter.js';
import { log as logActivity } from '../memory/activity-log.js';
import { t } from '../core/i18n.js';

const MAIN_CHAT_KEY = 'main_chat';   // native branch/checkpoint marker in chat_metadata
const HANDLED_CAP = 200;             // how many handled branches we remember (rolling)

function ctx() { return SillyTavern.getContext(); }
function currentChatId() { try { return ctx().getCurrentChatId?.() ?? null; } catch { return null; } }
function parentChat() {
  try { return ctx().chatMetadata?.[MAIN_CHAT_KEY] || null; } catch { return null; }
}

// --- Global handled-set (in settings, NOT in chatMetadata) ---
// Stored in extension_settings → not copied by a fork, so a sub-branch of an
// already-handled branch still asks (no false "already handled").
function handledList() {
  const b = getSettings().branch;
  if (!Array.isArray(b._handled)) b._handled = [];
  return b._handled;
}
function isHandled(chatId) { return !!chatId && handledList().includes(chatId); }
function markHandled(chatId) {
  if (!chatId) return;
  const list = handledList();
  if (list.includes(chatId)) return;
  list.push(chatId);
  if (list.length > HANDLED_CAP) list.splice(0, list.length - HANDLED_CAP); // drop oldest
  saveSettings();
}

/**
 * Action-choice popup on fork. Build a REAL DOM (callGenericPopup may isolate it
 * — keep refs in the closure). Returns
 * { action:'fork'|'share', name } | null (cancel).
 */
async function forkPopup(parentBook, suggestedName) {
  const c = ctx();
  const wrap = document.createElement('div');
  wrap.className = 'cl-choose';
  wrap.innerHTML = `
    <h3>${t('popup.branch.title')}</h3>
    <p>${t('popup.branch.body1', { parent: escapeHtml(parentChat() || t('popup.branch.anotherChat')), book: escapeHtml(parentBook) })}</p>
    <p>${t('popup.branch.body2')}</p>
    <label class="cl-choose-row">
      <input type="radio" name="cl-fork" value="fork" checked>
      <span>${t('popup.branch.fork')}</span>
    </label>
    <label class="cl-choose-row">
      <input class="cl-forkname" type="text" value="${escapeHtml(suggestedName)}" style="width:100%">
    </label>
    <label class="cl-choose-row">
      <input type="radio" name="cl-fork" value="share">
      <span>${t('popup.branch.share')}</span>
    </label>`;

  const nameInput = wrap.querySelector('.cl-forkname');

  const POPUP_TYPE = c.POPUP_TYPE ?? {};
  const POPUP_RESULT = c.POPUP_RESULT ?? {};
  let res;
  try {
    res = await c.callGenericPopup(wrap, POPUP_TYPE.CONFIRM ?? 2, '', {
      okButton: t('popup.apply'), cancelButton: t('popup.cancel'),
    });
  } catch (e) {
    console.warn('[ChaoticLorebooks] branch popup failed:', e);
    return null;
  }
  const affirmative = POPUP_RESULT.AFFIRMATIVE ?? 1;
  if (res !== affirmative && res !== true) return null;     // cancel → don't mark handled

  const action = wrap.querySelector('input[name="cl-fork"]:checked')?.value || 'fork';
  return { action, name: (nameInput?.value || suggestedName).trim() };
}

// Minimal HTML escaper (DOMPurify not needed here — book names are short).
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Apply book fork: copy+rebind, reconcile arcs, notify. */
async function doFork(parentBook, dstName) {
  const created = await forkBook(parentBook, dstName);
  if (!created) {                              // copy failed → share the book (old behavior)
    globalThis.toastr?.warning?.(t('toast.branch.forkFail'));
    return false;
  }
  try { await reconcileArcsToChat(); } catch { /* best-effort */ }
  globalThis.toastr?.success?.(t('toast.branch.forkOk', { name: created }));
  logActivity({ kind: 'branch', detail: `forked own book: ${created}` }).catch(() => {});
  return true;
}

/**
 * Called on CHAT_CHANGED. If the current chat is a freshly-entered branch
 * sharing a book with its parent, offer to isolate it. Fully guarded: any
 * error → no-op (never block the chat switch).
 */
export async function maybeHandleFork() {
  try {
    const s = getSettings();
    if (s.branch?.enabled === false) return;          // feature off
    if (!parentChat()) return;                         // not a branch/checkpoint → exit

    const chatId = currentChatId();
    if (isHandled(chatId)) return;                     // already handled this branch

    const book = getBoundBookName();
    if (!book) { markHandled(chatId); return; }        // nothing to isolate

    const suggested = deriveBranchBookName(book);
    const action = s.branch?.defaultAction === 'share' ? 'share' : 'fork';

    if (s.branch?.askOnFork === false) {               // no prompt — use defaultAction
      if (action === 'fork') await doFork(book, suggested);
      markHandled(chatId);
      return;
    }

    const choice = await forkPopup(book, suggested);
    if (!choice) return;                               // cancel → ask again next entry
    if (choice.action === 'fork') await doFork(book, choice.name || suggested);
    markHandled(chatId);                               // fork OR share → stop asking
  } catch (e) {
    console.warn('[ChaoticLorebooks] maybeHandleFork error:', e);
  }
}

/** Debug/test: forget that a branch was handled (so the popup shows again). */
export function resetHandledForChat(chatId) {
  const list = handledList();
  const i = list.indexOf(chatId ?? currentChatId());
  if (i >= 0) { list.splice(i, 1); saveSettings(); }
}
