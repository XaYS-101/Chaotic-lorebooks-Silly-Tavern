// global-reconciler.js — изоляция памяти, когда наша книга активна ГЛОБАЛЬНО
// (SPEC §2, последний срез Фазы D). Всё 🟢. Зеркало branch-guard, но для другой
// угрозы.
//
// Проблема: расширение пишет память в книгу, привязанную к ТЕКУЩЕМУ чату
// (chat_metadata.world_info). Но в ST есть и ГЛОБАЛЬНО активные книги
// (мультиселект «Active World(s)» = selected_world_info), которые применяются ко
// ВСЕМ чатам. Если книга, в которую мы пишем, оказалась ещё и в этом глобальном
// наборе — фоновый писатель льёт память ЭТОГО чата во все остальные (перекрёстное
// заражение). Та же беда, что branch-guard решает для форка, но в глобальном масштабе.
//
// Решение: при входе в чат, если привязанная книга активна глобально, предложить:
//   • Copy — приватная копия этой книги для текущего чата (ребинд) → автоматика
//     пишет только в копию, глобальный оригинал не трогается;
//   • Disable global — убрать книгу из глобального набора (через нативный
//     обработчик ST), чтобы здесь она активировалась лишь как привязка чата;
//   • Keep — оставить как есть.
// Без LLM, во всех режимах, идемпотентно, не спрашивает дважды про один чат.
//
// Сверено с ST (public/scripts/world-info.js):
//   - глобальный набор = selected_world_info (НЕ на getContext) ↔ мультиселект
//     #world_info; источник истины для чтения — выбранные <option> этого селекта.
//   - снять книгу с глобали штатно: снять <option> в #world_info и .trigger('change')
//     → ST сам обновит selected_world_info, сохранит и эмитнет WORLDINFO_SETTINGS_UPDATED.
//   - копия книги делается через lorebook-service.forkBook (он же ребиндит чат).

import { getSettings, saveSettings } from './settings.js';
import { getBoundBookName, forkBook, deriveBranchBookName } from './lorebook-service.js';
import { log as logActivity } from './activity-log.js';
import { t } from './i18n.js';

const HANDLED_CAP = 200;   // сколько разобранных чатов помним (rolling)

function ctx() { return SillyTavern.getContext(); }
function currentChatId() { try { return ctx().getCurrentChatId?.() ?? null; } catch { return null; } }

// --- Глобальный handled-set (в настройках, НЕ в chatMetadata) ---
// Как у branch-guard: в extension_settings → не копируется форком чата, поэтому
// форк уже разобранного чата всё равно спросит (нет ложного «уже обработано»).
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

// Имена книг, выбранных в глобальном мультиселекте #world_info (текст <option>).
// Версионно-устойчиво (DOM — пользовательский источник истины); нет селекта → [].
function globalActiveBooks() {
  try {
    const opts = document.querySelectorAll('#world_info option:checked');
    return [...opts].map((o) => (o.textContent || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Состояние глобального пересечения. boundIsGlobal === false → вызыватели no-op
 * («нет глобальной книги → всё работает», SPEC §2).
 * @returns {{ boundIsGlobal: boolean, book: string|null, globals: string[] }}
 */
export function scanGlobal() {
  const book = getBoundBookName();
  const globals = globalActiveBooks();
  return { boundIsGlobal: !!book && globals.includes(book), book, globals };
}

/**
 * Copy-on-use: форкнуть привязанную книгу в приватную копию для текущего чата и
 * перебиндить. Автоматика теперь пишет только в копию (вне глобали) → заражение
 * исчезает. Возвращает true при успехе.
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
 * Убрать книгу из ГЛОБАЛЬНО активного набора через штатный обработчик ST:
 * снять её <option> в #world_info и эмитнуть change (ST сам сохранит + обновит
 * selected_world_info). Деградация: селект/опция не найдены → инструктивный тост.
 * Возвращает true, если удалось снять программно.
 */
export async function suggestDisable(book) {
  const name = book || getBoundBookName();
  if (!name) return false;
  try {
    const sel = document.getElementById('world_info');
    const opt = sel && [...sel.options].find((o) => (o.textContent || '').trim() === name);
    if (sel && opt && opt.selected) {
      opt.selected = false;
      // jQuery .trigger('change') — ST слушает именно его (select2); фолбэк — нативное событие.
      if (globalThis.jQuery) globalThis.jQuery(sel).trigger('change');
      else sel.dispatchEvent(new Event('change', { bubbles: true }));
      globalThis.toastr?.success?.(t('toast.global.disableOk', { name }));
      logActivity({ kind: 'global-disable', detail: `removed from global: ${name}` }).catch(() => {});
      return true;
    }
  } catch (e) {
    console.warn('[ChaoticLorebooks] suggestDisable failed:', e);
  }
  // Не смогли снять программно — подскажем, как это сделать вручную.
  globalThis.toastr?.info?.(t('toast.global.disableManual', { name }));
  return false;
}

// Минимальный экранировщик (имена книг короткие; DOMPurify тут не нужен).
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * Попап выбора действия. Строим РЕАЛЬНЫЙ DOM (callGenericPopup может его
 * изолировать — держим ссылки в замыкании). Возвращает
 * 'copy'|'disable'|'share' | null (отмена).
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
  if (res !== affirmative && res !== true) return null;       // отмена → не помечаем handled

  return wrap.querySelector('input[name="cl-global"]:checked')?.value || 'copy';
}

/** Применить выбранное действие (кроме 'share' — там ничего не делаем). */
async function applyAction(action, book) {
  if (action === 'copy') return copyOnUse(book);
  if (action === 'disable') return suggestDisable(book);
  return false;   // 'share' / неизвестное — оставить как есть
}

/**
 * Вызывается на CHAT_CHANGED (после branch-guard). Если книга, в которую пишет
 * текущий чат, активна глобально — предлагает изолировать память. Полностью
 * защищено: любая ошибка → no-op (смену чата не блокируем).
 */
export async function maybeHandleGlobal() {
  try {
    const s = getSettings();
    if (s.globalReconciler?.enabled === false) return;     // фича выключена

    const { boundIsGlobal, book } = scanGlobal();
    if (!boundIsGlobal) return;                            // нет пересечения → всё ок

    const chatId = currentChatId();
    if (isHandled(chatId)) return;                         // уже разбирались с этим чатом

    const action = s.globalReconciler?.defaultAction || 'copy';

    if (s.globalReconciler?.askOnDetected === false) {     // без вопроса — по defaultAction
      await applyAction(action, book);
      markHandled(chatId);
      return;
    }

    const choice = await globalPopup(book);
    if (!choice) return;                                  // отмена → спросим снова при след. входе
    await applyAction(choice, book);
    markHandled(chatId);                                  // любое решение → больше не спрашиваем
  } catch (e) {
    console.warn('[ChaoticLorebooks] maybeHandleGlobal error:', e);
  }
}

/** Debug/тест: забыть, что чат обработан (чтобы попап показался снова). */
export function resetHandledForChat(chatId) {
  const list = handledList();
  const i = list.indexOf(chatId ?? currentChatId());
  if (i >= 0) { list.splice(i, 1); saveSettings(); }
}
