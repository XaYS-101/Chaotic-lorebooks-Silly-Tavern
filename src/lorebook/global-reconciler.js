// global-reconciler.js — memory isolation when our book is active GLOBALLY
// (SPEC §2, last slice of Phase D). All 🟢. Mirror of branch-guard, for a
// different threat.
//
// Problem: the extension writes memory into the book bound to the CURRENT chat
// (chat_metadata.world_info). But ST also has GLOBALLY active books (the "Active
// World(s)" multiselect = selected_world_info) applied to ALL chats. If the book
// we write to is also in that global set, the background writer pours THIS chat's
// memory into every other chat (cross-contamination). Same issue branch-guard
// handles for forks, but at global scale.
//
// Solution: on entering a chat, if the bound book is globally active, offer:
//   • Copy — a private copy of this book for the current chat (rebind) →
//     automation writes only into the copy, the global original is untouched;
//   • Disable global — remove the book from the global set (via ST's native
//     handler) so here it activates only as the chat binding;
//   • Keep — leave as is.
// No LLM, all modes, idempotent, never asks twice for the same chat.
//
// Checked against ST (public/scripts/world-info.js):
//   - global set = selected_world_info (NOT on getContext) ↔ #world_info
//     multiselect; source of truth for reading is that select's checked <option>s.
//   - remove a book from global properly: deselect its <option> in #world_info and
//     .trigger('change') → ST updates selected_world_info, saves, and emits
//     WORLDINFO_SETTINGS_UPDATED.
//   - the book copy is made via lorebook-service.forkBook (which also rebinds the chat).

import { getSettings, saveSettings } from '../core/settings.js';
import { getBoundBookName, forkBook, deriveBranchBookName } from './lorebook-service.js';
import { log as logActivity } from '../memory/activity-log.js';
import { t } from '../core/i18n.js';

const HANDLED_CAP = 200;   // how many handled chats we remember (rolling)

function ctx() { return SillyTavern.getContext(); }
function currentChatId() { try { return ctx().getCurrentChatId?.() ?? null; } catch { return null; } }

// --- Global handled-set (in settings, NOT in chatMetadata) ---
// Like branch-guard: in extension_settings → not copied by a chat fork, so a
// fork of an already-handled chat still asks (no false "already handled").
function handledList() {
  const g = getSettings().globalReconciler;
  if (!Array.isArray(g._handled)) g._handled = [];
  return g._handled;
}
function isHandled(chatId) { return !!chatId && handledList().includes(chatId); }
function markHandled(chatId) {
  if (!chatId) return;
  const list = handledList();
  if (list.includes(chatId)) return;
  list.push(chatId);
  if (list.length > HANDLED_CAP) list.splice(0, list.length - HANDLED_CAP);
  saveSettings();
}

// Book names selected in the global #world_info multiselect (<option> text).
// Version-robust (DOM is the user's source of truth); no select → [].
function globalActiveBooks() {
  try {
    const opts = document.querySelectorAll('#world_info option:checked');
    return [...opts].map((o) => (o.textContent || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Global-overlap state. boundIsGlobal === false → callers no-op
 * ("no global book → everything works", SPEC §2).
 * @returns {{ boundIsGlobal: boolean, book: string|null, globals: string[] }}
 */
export function scanGlobal() {
  const book = getBoundBookName();
  const globals = globalActiveBooks();
  return { boundIsGlobal: !!book && globals.includes(book), book, globals };
}

/**
 * Copy-on-use: fork the bound book into a private copy for the current chat and
 * rebind. Automation now writes only into the copy (out of global) →
 * contamination is gone. Returns true on success.
 */
export async function copyOnUse(book) {
  const src = book || getBoundBookName();
  if (!src) return false;
  const created = await forkBook(src, deriveBranchBookName(src));
  if (!created) {
    globalThis.toastr?.warning?.(t('toast.global.copyFail'));
    return false;
  }
  globalThis.toastr?.success?.(t('toast.global.copyOk', { name: created }));
  logActivity({ kind: 'global-copy', detail: `private copy: ${created}` }).catch(() => {});
  return true;
}

/**
 * Remove a book from the GLOBALLY active set via ST's native handler: deselect
 * its <option> in #world_info and emit change (ST saves + updates
 * selected_world_info). Degradation: select/option missing → instructional toast.
 * Returns true if removed programmatically.
 */
export async function suggestDisable(book) {
  const name = book || getBoundBookName();
  if (!name) return false;
  try {
    const sel = document.getElementById('world_info');
    const opt = sel && [...sel.options].find((o) => (o.textContent || '').trim() === name);
    if (sel && opt && opt.selected) {
      opt.selected = false;
      // jQuery .trigger('change') — what ST listens for (select2); fallback to native event.
      if (globalThis.jQuery) globalThis.jQuery(sel).trigger('change');
      else sel.dispatchEvent(new Event('change', { bubbles: true }));
      globalThis.toastr?.success?.(t('toast.global.disableOk', { name }));
      logActivity({ kind: 'global-disable', detail: `removed from global: ${name}` }).catch(() => {});
      return true;
    }
  } catch (e) {
    console.warn('[ChaoticLorebooks] suggestDisable failed:', e);
  }
  // Couldn't remove programmatically — hint how to do it manually.
  globalThis.toastr?.info?.(t('toast.global.disableManual', { name }));
  return false;
}

// Minimal HTML escaper (book names are short; DOMPurify not needed here).
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * Action-choice popup. Build a REAL DOM (callGenericPopup may isolate it — keep
 * refs in the closure). Returns 'copy'|'disable'|'share' | null (cancel).
 */
async function globalPopup(book) {
  const c = ctx();
  const wrap = document.createElement('div');
  wrap.className = 'cl-choose';
  wrap.innerHTML = `
    <h3>${t('popup.global.title')}</h3>
    <p>${t('popup.global.body1', { book: escapeHtml(book) })}</p>
    <p>${t('popup.global.body2')}</p>
    <label class="cl-choose-row">
      <input type="radio" name="cl-global" value="copy" checked>
      <span>${t('popup.global.copy')}</span>
    </label>
    <label class="cl-choose-row">
      <input type="radio" name="cl-global" value="disable">
      <span>${t('popup.global.disable')}</span>
    </label>
    <label class="cl-choose-row">
      <input type="radio" name="cl-global" value="share">
      <span>${t('popup.global.keep')}</span>
    </label>`;

  const POPUP_TYPE = c.POPUP_TYPE ?? {};
  const POPUP_RESULT = c.POPUP_RESULT ?? {};
  let res;
  try {
    res = await c.callGenericPopup(wrap, POPUP_TYPE.CONFIRM ?? 2, '', {
      okButton: t('popup.apply'), cancelButton: t('popup.cancel'),
    });
  } catch (e) {
    console.warn('[ChaoticLorebooks] global popup failed:', e);
    return null;
  }
  const affirmative = POPUP_RESULT.AFFIRMATIVE ?? 1;
  if (res !== affirmative && res !== true) return null;       // cancel → don't mark handled

  return wrap.querySelector('input[name="cl-global"]:checked')?.value || 'copy';
}

/** Apply the chosen action (except 'share' — do nothing). */
async function applyAction(action, book) {
  if (action === 'copy') return copyOnUse(book);
  if (action === 'disable') return suggestDisable(book);
  return false;   // 'share' / unknown — leave as is
}

/**
 * Called on CHAT_CHANGED (after branch-guard). If the book the current chat
 * writes to is globally active, offer to isolate the memory. Fully guarded: any
 * error → no-op (never block the chat switch).
 */
export async function maybeHandleGlobal() {
  try {
    const s = getSettings();
    if (s.globalReconciler?.enabled === false) return;     // feature off

    const { boundIsGlobal, book } = scanGlobal();
    if (!boundIsGlobal) return;                            // no overlap → all good

    const chatId = currentChatId();
    if (isHandled(chatId)) return;                         // already handled this chat

    const action = s.globalReconciler?.defaultAction || 'copy';

    if (s.globalReconciler?.askOnDetected === false) {     // no prompt — use defaultAction
      await applyAction(action, book);
      markHandled(chatId);
      return;
    }

    const choice = await globalPopup(book);
    if (!choice) return;                                  // cancel → ask again next entry
    await applyAction(choice, book);
    markHandled(chatId);                                  // any decision → stop asking
  } catch (e) {
    console.warn('[ChaoticLorebooks] maybeHandleGlobal error:', e);
  }
}

/** Debug/test: forget that a chat was handled (so the popup shows again). */
export function resetHandledForChat(chatId) {
  const list = handledList();
  const i = list.indexOf(chatId ?? currentChatId());
  if (i >= 0) { list.splice(i, 1); saveSettings(); }
}
