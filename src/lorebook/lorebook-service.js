// lorebook-service.js — working with the bound lorebook (World Info).
// Responsible for: the "choose existing / create new / cancel" popup, binding a
// book to the chat (via ST's NATIVE key so the WI engine activates it), and
// reading entries. All 🟢.
//
// Checked against ST sources (public/scripts/world-info.js, st-context.js, popup.js):
//   - loadWorldInfo / saveWorldInfo / updateWorldInfoList — ON getContext().
//   - createNewWorldInfo / createWorldInfoEntry — NOT on context; we replicate via
//     saveWorldInfo({entries:{}}) and our own entry template (lorebook-writer).
//   - NATIVE book-to-chat binding: chat_metadata['world_info'] (METADATA_KEY).
//     This key is what makes ST scan/activate the book → satisfies hard rule #1
//     (a standalone book works on its own).
//   - world_names is NOT on context; read from globalThis or the #world_info DOM select.

import { t } from '../core/i18n.js';
import { getSettings } from '../core/settings.js';

// Our "informational" key (for migration/clarity). NATIVE_KEY drives real activation.
const BIND_KEY = 'chaoticLorebooks_book';
// METADATA_KEY from world-info.js — the one chat-bound book ST actually activates.
const NATIVE_KEY = 'world_info';

function ctx() { return SillyTavern.getContext(); }

/** Name of the book bound to the current chat (our key → native fallback). */
export function getBoundBook() {
  const meta = ctx().chatMetadata ?? {};
  return meta[BIND_KEY] ?? meta[NATIVE_KEY] ?? null;
}

async function bindBook(name) {
  const meta = ctx().chatMetadata;
  meta[NATIVE_KEY] = name;   // ← ST activates this binding
  meta[BIND_KEY] = name;     // ← our key (migration/clarity)
  await ctx().saveMetadata();
  // The native WI panel reads its list on rebind — nudge it if the method exists.
  try { await ctx().updateWorldInfoList?.(); } catch { /* no-op */ }
}

/** Rebind the current chat to a different book (public, for branch-guard). */
export async function rebindBook(name) { await bindBook(name); }

/** Names of existing World Info books. Several sources with fallback. */
function listWorldBooks() {
  // 1) global world_names (export from world-info.js, often on window).
  try {
    if (Array.isArray(globalThis.world_names)) return globalThis.world_names.slice();
  } catch { /* ignore */ }
  // 2) options of the native book select in the DOM.
  try {
    const sel = document.getElementById('world_editor_select') || document.getElementById('world_info');
    if (sel) {
      return Array.from(sel.options)
        .map((o) => o.textContent?.trim())
        .filter((name) => name && name !== 'None' && name !== '--- Pick to Edit ---');
    }
  } catch { /* ignore */ }
  return [];
}

function fillTemplate(tpl) {
  const c = ctx();
  const charName = c.characters?.[c.characterId]?.name ?? 'Char';
  const chatId = c.getCurrentChatId?.() ?? 'chat';
  return String(tpl)
    .replace('{{char}}', charName)
    .replace('{{user}}', c.name1 ?? 'You')
    .replace('{{chat}}', chatId);
}

/**
 * Ensure a bound book exists.
 *   interactive=true (default): if no book and askOnFirstUse — show the popup
 *     (existing / new / cancel). Called on EXPLICIT user actions (note, promote
 *     favorite), so the book is created "later" — on the first write, not on the
 *     first message.
 *   interactive=false: no popup, silently create from template (background writes).
 * Returns the book name or null (on cancel).
 */
export async function ensureBook(settings, { interactive = true } = {}) {
  const existing = getBoundBook();
  if (existing) return existing;

  if (!interactive || !settings.askOnFirstUse) {
    return createAndBind(fillTemplate(settings.lorebookNameTemplate));
  }

  const books = listWorldBooks();
  const choice = await showChooseBookPopup(books, fillTemplate(settings.lorebookNameTemplate));
  if (!choice) return null;                 // cancel
  if (choice.type === 'existing') { await bindBook(choice.name); return choice.name; }
  return createAndBind(choice.name);
}

/**
 * Silently ensure a book for a BACKGROUND write (no popup). Called by the writer
 * when the first real entry arrives but no book exists → create from template.
 */
export async function ensureBookForWrite() {
  const existing = getBoundBook();
  if (existing) return existing;
  return ensureBook(getSettings(), { interactive: false });
}

async function createAndBind(name) {
  // createNewWorldInfo not on context → replicate: empty book + save.
  try {
    const existing = listWorldBooks();
    if (!existing.includes(name)) {
      await ctx().saveWorldInfo(name, { entries: {} }, true);
      await ctx().updateWorldInfoList?.();
    }
  } catch (e) {
    console.warn('[ChaoticLorebooks] create book failed:', e);
  }
  await bindBook(name);
  return name;
}

/**
 * Book-choice popup. Build a REAL DOM element and read values from it
 * (callGenericPopup may isolate the DOM — keep refs in the closure, don't use
 * document.getElementById). Returns {type:'existing'|'new',name} | null.
 */
async function showChooseBookPopup(books, defaultNewName) {
  const c = ctx();
  const wrap = document.createElement('div');
  wrap.className = 'cl-choose';
  wrap.innerHTML = `
    <h3>${t('popup.choose.title')}</h3>
    <p>${t('popup.choose.body')}</p>
    <label class="cl-choose-row">
      <input type="radio" name="cl-mode" value="existing" ${books.length ? 'checked' : 'disabled'}>
      <span>${t('popup.choose.useExisting')}</span>
      <select class="cl-existing" ${books.length ? '' : 'disabled'}>
        ${books.map((b) => `<option value="${b}">${b}</option>`).join('')}
      </select>
    </label>
    <label class="cl-choose-row">
      <input type="radio" name="cl-mode" value="new" ${books.length ? '' : 'checked'}>
      <span>${t('popup.choose.createNew')}</span>
      <input class="cl-newname" type="text" value="${defaultNewName}">
    </label>`;

  const existingSel = wrap.querySelector('.cl-existing');
  const newInput = wrap.querySelector('.cl-newname');

  const POPUP_TYPE = c.POPUP_TYPE ?? {};
  const POPUP_RESULT = c.POPUP_RESULT ?? {};
  let res;
  try {
    res = await c.callGenericPopup(wrap, POPUP_TYPE.CONFIRM ?? 2, '', {
      okButton: t('popup.ok'), cancelButton: t('popup.cancel'),
    });
  } catch (e) {
    console.warn('[ChaoticLorebooks] popup failed:', e);
    return null;
  }
  const affirmative = POPUP_RESULT.AFFIRMATIVE ?? 1;
  if (res !== affirmative && res !== true) return null;

  const mode = wrap.querySelector('input[name="cl-mode"]:checked')?.value;
  if (mode === 'existing' && existingSel?.value) {
    return { type: 'existing', name: existingSel.value };
  }
  return { type: 'new', name: (newInput?.value || defaultNewName).trim() };
}

/** Read the bound book's entries (array). Checked: ctx.loadWorldInfo. */
export async function readEntries() {
  const name = getBoundBook();
  if (!name) return [];
  try {
    const data = ctx().loadWorldInfo ? await ctx().loadWorldInfo(name) : null;
    if (!data?.entries) return [];
    return Object.values(data.entries);
  } catch (e) {
    console.warn('[ChaoticLorebooks] readEntries failed:', e);
    return [];
  }
}

/** Name of the chat-bound book (for writer/backup). null if none. */
export function getBoundBookName() { return getBoundBook(); }

/** Ensure a unique book name: append " #2", " #3"… on collision. */
function uniqueBookName(base) {
  const existing = new Set(listWorldBooks());
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base} #${i}`;
    if (!existing.has(cand)) return cand;
  }
  return `${base} #${Date.now ? '' : ''}new`;   // practically unreachable
}

/**
 * Book name for a chat BRANCH (fork). Take the name template from settings and
 * fill it with the current (branch) chatId, so the name DIFFERS from the parent
 * book. If they match (e.g. template without {{chat}}) — append " — branch".
 */
export function deriveBranchBookName(srcName) {
  let name;
  try {
    const tpl = SillyTavern.getContext().extensionSettings?.chaoticLorebooks?.lorebookNameTemplate
      || '🌀 {{char}} — {{chat}}';
    name = fillTemplate(tpl);
  } catch { name = `${srcName} — branch`; }
  if (!name || name === srcName) name = `${srcName} — branch`;
  return uniqueBookName(name);
}

/**
 * Fork a book: copy ALL entries of the bound book (including the disabled graph
 * manifest entry) into a new book and rebind the current (branch) chat to the
 * copy. The branch's memory no longer writes into the parent's book (timeline
 * isolation). Returns the new book name, or null on error (then the branch
 * shares the book — old behavior).
 */
export async function forkBook(srcName, dstName) {
  if (!srcName) return null;
  const dst = dstName || deriveBranchBookName(srcName);
  try {
    const data = await ctx().loadWorldInfo(srcName);
    const copy = data && typeof data === 'object'
      ? structuredClone(data)
      : { entries: {} };
    if (!copy.entries) copy.entries = {};
    await ctx().saveWorldInfo(dst, copy, true);
    await ctx().updateWorldInfoList?.();
  } catch (e) {
    console.warn('[ChaoticLorebooks] forkBook copy failed:', e);
    return null;
  }
  await bindBook(dst);
  return dst;
}
