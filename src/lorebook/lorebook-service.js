// lorebook-service.js — работа с привязанным лорбуком (World Info).
// Отвечает за: попап «выбрать существующий / создать новый / отмена»,
// привязку книги к чату (через НАТИВНЫЙ ключ ST, чтобы движок WI её активировал),
// чтение энтри. Всё 🟢.
//
// Сверено с исходниками ST (public/scripts/world-info.js, st-context.js, popup.js):
//   - loadWorldInfo / saveWorldInfo / updateWorldInfoList — НА getContext().
//   - createNewWorldInfo / createWorldInfoEntry — НЕ на context; реплицируем
//     через saveWorldInfo({entries:{}}) и собственный шаблон энтри (lorebook-writer).
//   - НАТИВНАЯ привязка книги к чату: chat_metadata['world_info'] (METADATA_KEY).
//     Именно этот ключ заставляет ST сканировать/активировать книгу → выполняется
//     железное правило #1 (standalone-книга работает сама).
//   - world_names НЕ на context; берём из globalThis либо из DOM-селекта #world_info.

import { t } from '../core/i18n.js';
import { getSettings } from '../core/settings.js';

// Наш «информационный» ключ (для миграции/ясности). Реальную активацию даёт NATIVE_KEY.
const BIND_KEY = 'chaoticLorebooks_book';
// METADATA_KEY из world-info.js — единственная книга, привязанная к чату, которую ST активирует.
const NATIVE_KEY = 'world_info';

function ctx() { return SillyTavern.getContext(); }

/** Имя привязанной к текущему чату книги (наш ключ → фолбэк на нативный). */
export function getBoundBook() {
  const meta = ctx().chatMetadata ?? {};
  return meta[BIND_KEY] ?? meta[NATIVE_KEY] ?? null;
}

async function bindBook(name) {
  const meta = ctx().chatMetadata;
  meta[NATIVE_KEY] = name;   // ← ST активирует именно эту привязку
  meta[BIND_KEY] = name;     // ← наш ключ (миграция/ясность)
  await ctx().saveMetadata();
  // Нативная панель WI читает список при ребинде — подтолкнём, если метод есть.
  try { await ctx().updateWorldInfoList?.(); } catch { /* no-op */ }
}

/** Перебиндить текущий чат на другую книгу (публично, для branch-guard). */
export async function rebindBook(name) { await bindBook(name); }

/** Список имён существующих World Info книг. Несколько источников с фолбэком. */
function listWorldBooks() {
  // 1) глобал world_names (экспорт world-info.js, часто доступен на window).
  try {
    if (Array.isArray(globalThis.world_names)) return globalThis.world_names.slice();
  } catch { /* ignore */ }
  // 2) опции нативного селекта книг в DOM.
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
 * Гарантировать привязанную книгу.
 *   interactive=true (дефолт): если книги нет и askOnFirstUse — показать попап
 *     (существующая / новая / отмена). Зовётся на ЯВНЫХ действиях юзера (заметка,
 *     промоут избранного), поэтому книга создаётся «позже» — при первой записи, а
 *     не на первом сообщении.
 *   interactive=false: без попапа, сразу тихо создать по шаблону (фоновые записи).
 * Возвращает имя книги или null (если отмена).
 */
export async function ensureBook(settings, { interactive = true } = {}) {
  const existing = getBoundBook();
  if (existing) return existing;

  if (!interactive || !settings.askOnFirstUse) {
    return createAndBind(fillTemplate(settings.lorebookNameTemplate));
  }

  const books = listWorldBooks();
  const choice = await showChooseBookPopup(books, fillTemplate(settings.lorebookNameTemplate));
  if (!choice) return null;                 // отмена
  if (choice.type === 'existing') { await bindBook(choice.name); return choice.name; }
  return createAndBind(choice.name);
}

/**
 * Тихо гарантировать книгу для ФОНОВОЙ записи (без попапа). Зовётся writer'ом,
 * когда пришла первая реальная энтри, а книги ещё нет → создаём по шаблону.
 */
export async function ensureBookForWrite() {
  const existing = getBoundBook();
  if (existing) return existing;
  return ensureBook(getSettings(), { interactive: false });
}

async function createAndBind(name) {
  // createNewWorldInfo нет на context → реплицируем: пустая книга + сохранение.
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
 * Попап выбора книги. Строим РЕАЛЬНЫЙ DOM-элемент и читаем значения из него
 * (callGenericPopup может изолировать DOM — держим ссылки в замыкании, не ищем
 * по document.getElementById). Возвращает {type:'existing'|'new',name} | null.
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

/** Прочитать энтри привязанной книги (массив). Сверено: ctx.loadWorldInfo. */
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

/** Имя книги, привязанной к чату (для writer/backup). null если нет. */
export function getBoundBookName() { return getBoundBook(); }

/** Гарантировать уникальность имени книги: добавить « #2», « #3»… при коллизии. */
function uniqueBookName(base) {
  const existing = new Set(listWorldBooks());
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base} #${i}`;
    if (!existing.has(cand)) return cand;
  }
  return `${base} #${Date.now ? '' : ''}new`;   // практически недостижимо
}

/**
 * Имя книги для ВЕТКИ чата (форк). Берём шаблон имени из настроек и заполняем
 * текущим (ветка-)chatId, поэтому имя ОТЛИЧАЕТСЯ от родительской книги. Если
 * совпало (напр. шаблон без {{chat}}) — добавляем суффикс « — branch».
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
 * Форк книги: копировать ВСЕ энтри привязанной книги (включая отключённую
 * manifest-энтри графа) в новую книгу и перебиндить текущий (ветка-)чат на копию.
 * Так память ветки не пишется в книгу родителя (изоляция таймлайнов).
 * Возвращает имя новой книги, либо null при ошибке (тогда ветка делит книгу — старое поведение).
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
