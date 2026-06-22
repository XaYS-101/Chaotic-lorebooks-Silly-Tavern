// branch-guard.js — изоляция памяти при форке чата (SPEC §7, отложено с Фазы A). Всё 🟢.
//
// Проблема: ST при ветвлении чата (branchChat → «… - Branch #N») КОПИРУЕТ
// chat_metadata родителя в новый чат — вместе с привязкой книги (world_info) и
// всем нашим состоянием (chaoticLorebooks_*). Таймлайны расходятся, но ДЕЛЯТ
// одну книгу: в autonomous фоновый агент ветки пишет арки/граф/воспоминания в
// книгу РОДИТЕЛЯ, переписывая его память событиями, которых там не было.
//
// Решение: при входе в форк предложить дать ветке СВОЮ книгу (копия → ребинд).
// Без LLM, во всех режимах, идемпотентно, не спрашивает дважды про одну ветку.
//
// Сверено с ST (public/scripts/bookmarks.js, script.js):
//   - отдельного события ветвления НЕТ; форк лишь шлёт CHAT_CHANGED после открытия.
//   - признак ветки/чекпойнта: chat_metadata.main_chat = имя родительского чата.
//   - на форке metadata = {...chat_metadata, ...{main_chat}} → наследуется world_info.

import { getSettings, saveSettings } from '../core/settings.js';
import { getBoundBookName, forkBook, deriveBranchBookName } from './lorebook-service.js';
import { reconcileArcsToChat } from '../memory/arc-segmenter.js';
import { log as logActivity } from '../memory/activity-log.js';
import { t } from '../core/i18n.js';

const MAIN_CHAT_KEY = 'main_chat';   // нативный маркер ветки/чекпойнта в chat_metadata
const HANDLED_CAP = 200;             // сколько обработанных веток помним (rolling)

function ctx() { return SillyTavern.getContext(); }
function currentChatId() { try { return ctx().getCurrentChatId?.() ?? null; } catch { return null; } }
function parentChat() {
  try { return ctx().chatMetadata?.[MAIN_CHAT_KEY] || null; } catch { return null; }
}

// --- Глобальный handled-set (в настройках, НЕ в chatMetadata) ---
// Хранится в extension_settings → не копируется форком, поэтому суб-ветка
// уже обработанной ветки всё равно спросит (нет ложного «уже обработано»).
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
  if (list.length > HANDLED_CAP) list.splice(0, list.length - HANDLED_CAP); // выкинуть старые
  saveSettings();
}

/**
 * Попап выбора действия на форке. Строим РЕАЛЬНЫЙ DOM (callGenericPopup может
 * изолировать его — держим ссылки в замыкании). Возвращает
 * { action:'fork'|'share', name } | null (отмена).
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
  if (res !== affirmative && res !== true) return null;     // отмена → не помечаем handled

  const action = wrap.querySelector('input[name="cl-fork"]:checked')?.value || 'fork';
  return { action, name: (nameInput?.value || suggestedName).trim() };
}

// Минимальный экранировщик (DOMPurify не обязателен здесь — имена книг короткие).
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Применить форк книги: копия+ребинд, подгонка арок, уведомление. */
async function doFork(parentBook, dstName) {
  const created = await forkBook(parentBook, dstName);
  if (!created) {                              // копия не удалась → делим книгу (старое поведение)
    globalThis.toastr?.warning?.(t('toast.branch.forkFail'));
    return false;
  }
  try { await reconcileArcsToChat(); } catch { /* best-effort */ }
  globalThis.toastr?.success?.(t('toast.branch.forkOk', { name: created }));
  logActivity({ kind: 'branch', detail: `forked own book: ${created}` }).catch(() => {});
  return true;
}

/**
 * Вызывается на CHAT_CHANGED. Если текущий чат — свежевошедшая ветка, делящая
 * книгу с родителем, предлагает изолировать её. Полностью защищено: любая
 * ошибка → no-op (смену чата не блокируем).
 */
export async function maybeHandleFork() {
  try {
    const s = getSettings();
    if (s.branch?.enabled === false) return;          // фича выключена
    if (!parentChat()) return;                         // не ветка/чекпойнт → выходим

    const chatId = currentChatId();
    if (isHandled(chatId)) return;                     // уже разбирались с этой веткой

    const book = getBoundBookName();
    if (!book) { markHandled(chatId); return; }        // нечего изолировать

    const suggested = deriveBranchBookName(book);
    const action = s.branch?.defaultAction === 'share' ? 'share' : 'fork';

    if (s.branch?.askOnFork === false) {               // без вопроса — по defaultAction
      if (action === 'fork') await doFork(book, suggested);
      markHandled(chatId);
      return;
    }

    const choice = await forkPopup(book, suggested);
    if (!choice) return;                               // отмена → спросим снова при след. входе
    if (choice.action === 'fork') await doFork(book, choice.name || suggested);
    markHandled(chatId);                               // fork ИЛИ share → больше не спрашиваем
  } catch (e) {
    console.warn('[ChaoticLorebooks] maybeHandleFork error:', e);
  }
}

/** Debug/тест: забыть, что ветка обработана (чтобы попап показался снова). */
export function resetHandledForChat(chatId) {
  const list = handledList();
  const i = list.indexOf(chatId ?? currentChatId());
  if (i >= 0) { list.splice(i, 1); saveSettings(); }
}
