// index.js — ТОНКИЙ оркестратор. Только init, проводка событий и регистрация
// точек входа. Вся логика — в модулях.

import { getSettings, saveSettings, MODULE_NAME } from './src/core/settings.js';
import { injectContext } from './src/inject/injector.js';
import { isChatEnabled, toggleChatEnabled } from './src/core/chat-state.js';
import { decayTick } from './src/memory/thought-buffer.js';
import { toggleFavorite, isFav, addQuote, reconcileFavoritesAfterDelete } from './src/inject/favorites.js';
import { toggleDrawer, ensureDrawer } from './src/ui/tree-ui.js';
import { renderSettingsPanel } from './src/core/settings-panel.js';
import { reset as resetScene } from './src/memory/scene-detector.js';
import { resetCache as resetMemoryCache } from './src/memory/memory-engine.js';
import { log as logActivity } from './src/memory/activity-log.js';
// --- Фаза A — фундамент ---
import { onMessage as arcOnMessage, onEdit as arcOnEdit, reset as resetArc, sealReady, seedBaselineIfNeeded } from './src/memory/arc-segmenter.js';
import { maybeOfferBackfill, runBackfillFlow } from './src/memory/backfill.js';
import { maintain as autoHideMaintain, revealAll as autoHideRevealAll } from './src/memory/auto-hide.js';
import { resumeAfterRestart, registerHandler, enqueue } from './src/core/job-queue.js';
import { noteUserEditing } from './src/lorebook/lorebook-writer.js';
import { snapshot as backupSnapshot } from './src/lorebook/backup.js';
// --- Фаза B — извлечение + граф + ярусы ---
import { summarizeArc } from './src/memory/arc-summary.js';
import { addTriples, invalidateArc } from './src/memory/knowledge-graph.js';
// --- Фаза C — глубокое извлечение (allow-list + значимость + дрейф) ---
import { extractArc } from './src/memory/deep-extractor.js';
// --- Фаза D — дорогой кросс-арочный аудит дрейфа ---
import { runAudit, noteSettledForAudit } from './src/memory/drift-monitor.js';
// --- branch-guard — изоляция памяти при форке чата ---
import { maybeHandleFork } from './src/lorebook/branch-guard.js';
// --- global-reconciler — изоляция, когда наша книга активна глобально ---
import { maybeHandleGlobal } from './src/lorebook/global-reconciler.js';
// --- i18n — EN/RU локализация UI/тостов/слэш-команд ---
import { t } from './src/core/i18n.js';
// --- purge — on-open metadata self-cleanup after "clear all data" (backstop) ---
import { purgeCurrentChatIfArmed } from './src/core/purge.js';

// --- Глобальный перехватчик промпта (имя совпадает с manifest) ---
// Вызывается ДО запроса генерации: тут мы собираем и вкладываем контекст.
globalThis.chaoticLorebooks_interceptor = async function (chat, contextSize, abort, type) {
  try {
    const s = getSettings();
    if (!s.enabled || !isChatEnabled()) return;   // мастер-тумблер ИЛИ выключено для этого чата
    // Книгу тут БОЛЬШЕ НЕ создаём — лениво при первой реальной записи (см. lorebook-writer).
    await injectContext(type);  // type: свайпы → кэш; quiet → пропуск; см. injector
  } catch (e) {
    console.warn('[ChaoticLorebooks] interceptor error:', e);
  }
};

function init() {
  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  getSettings();              // инициализировать дефолты
  ensureDrawer();             // создать (скрытое) дерево
  renderSettingsPanel();      // панель настроек (Basic/Advanced + Mode)
  addWandButton();            // кнопка открытия в меню
  registerSlashCommands(ctx);
  registerJobHandlers();      // обработчики фоновых джоб (Фаза A)
  injectFavoriteStars();      // звёзды на сообщениях
  setupQuoteFab();            // плавающая кнопка «сохранить цитату» при выделении (тач)

  // Сброс UI при смене чата (метаданные буфера/избранного — свои на чат)
  eventSource.on(event_types.CHAT_CHANGED, async () => {
    purgeCurrentChatIfArmed().catch(warn); // if the purge backstop is armed, scrub this chat's keys
    resetScene(); resetArc(); resetMemoryCache(); injectFavoriteStars();
    resumeAfterRestart();     // возобновить persisted-очередь нового чата
    maybeHandleFork().catch(warn); // ветка чата делит книгу с родителем? предложить форк
    maybeHandleGlobal().catch(warn); // книга, в которую пишем, активна глобально? предложить копию
    // Поздно-включённый чат: посадить baseline (анти-мега-арка) и при необходимости
    // предложить разовый backfill (модал 1 раз на чат + баннер в дровере).
    try {
      const threshold = getSettings().backfill?.threshold ?? 10;
      await seedBaselineIfNeeded(threshold);
      await maybeOfferBackfill();
    } catch (e) { warn(e); }
  });
  // Долить звёзды на свежеотрисованные сообщения
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => injectFavoriteStars());
  eventSource.on(event_types.USER_MESSAGE_RENDERED, () => injectFavoriteStars());

  // --- Фаза A: арки / авто-скрытие / очередь ---
  // Устоявшийся ход (бот-соо) — двигаем watermark, при дозревании запечатываем арку.
  if (event_types.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => onSettledTurn().catch(warn));
  }
  // Правка старого соо → гейт опечаток → возможно dirty той арки → откат+переизвлечение.
  if (event_types.MESSAGE_EDITED) {
    eventSource.on(event_types.MESSAGE_EDITED, (idx) => onEditedTurn(idx).catch(warn));
  }
  // Юзер правит World Info вручную → откладываем авто-записи (CAS/defer).
  if (event_types.WORLDINFO_UPDATED) {
    eventSource.on(event_types.WORLDINFO_UPDATED, () => noteUserEditing());
  }
  // Удаление соо → сдвигаем mesIndex у избранных, выкидываем привязанные к удалённому;
  // звезда сама перестанет светиться после re-render (иначе выглядит будто соо ещё захвачено).
  if (event_types.MESSAGE_DELETED) {
    eventSource.on(event_types.MESSAGE_DELETED, async (idx) => {
      try {
        const n = Number(idx);
        await reconcileFavoritesAfterDelete(Number.isFinite(n) ? n : -1);
        document.querySelectorAll('#chat .mes .cl-star').forEach((s) => s.remove());
        injectFavoriteStars();
      } catch (e) { warn(e); }
    });
  }

  resumeAfterRestart();       // на старте — поднять незавершённые джобы
  console.log('[ChaoticLorebooks] initialized');
}

const warn = (e) => console.warn('[ChaoticLorebooks]', e);

/** Один устоявшийся ход: продвинуть арку; на запечатывании — скрыть пласт + снапшот + извлечение. */
async function onSettledTurn() {
  const s = getSettings();
  if (!s.enabled || !isChatEnabled()) return;
  const sealed = await arcOnMessage();
  if (sealed) {
    resetMemoryCache();                 // §4b: новая арка → кэш ядра устарел, пересоберём на сдвиге
    logActivity({ kind: 'arc-seal', arcId: sealed.id, detail: `#${sealed.start}–${sealed.end}` }).catch(warn);
    await autoHideMaintain();           // спрятать дозревший пласт (если уже суммаризован)
    if (s.backup?.enabled) backupSnapshot('arc-seal').catch(warn);
    // Фаза B: извлечение (саммари+граф) — дешёвой фон-джобой во всех режимах, кроме lite.
    if (s.mode !== 'lite') enqueue('arc-extract', { arcId: sealed.id }).catch(warn);
  }
  // Фаза D: раз в ~N устоявшихся ходов — дорогой кросс-арочный аудит (только autonomous).
  if (s.autonomous?.enabled && s.drift?.auditEnabled !== false && noteSettledForAudit()) {
    enqueue('audit-expensive', {}).catch(warn);
  }
}

/**
 * Побочки запечатывания арки для РУЧНЫХ путей (/cl-arc, кнопка «Запечатать сейчас»):
 * запись в активность + снапшот + авто-скрытие + дешёвая джоба саммари. Зеркалит
 * onSettledTurn, чтобы таймлайн/память не зависели от того, авто это или вручную.
 */
export async function afterSeal(sealed) {
  if (!sealed) return;
  const s = getSettings();
  resetMemoryCache();
  logActivity({ kind: 'arc-seal', arcId: sealed.id, detail: `#${sealed.start}–${sealed.end}` }).catch(warn);
  if (s.backup?.enabled) backupSnapshot('arc-seal').catch(warn);
  if (s.mode !== 'lite') enqueue('arc-extract', { arcId: sealed.id }).catch(warn);
  await autoHideMaintain().catch(warn);
}

/** Правка старого соо: гейт опечаток в арк-сегментере; существенная → откат+переизвлечение. */
async function onEditedTurn(idx) {
  if (!isChatEnabled()) return;
  const arc = await arcOnEdit(idx);     // null если опечатка / правка в живом окне
  if (!arc) return;
  const s = getSettings();
  if (!s.autonomous?.enabled) return;   // без воркера просто помечена dirty (обработается позже)
  // Откатить вклад этой арки в граф, затем переизвлечь начисто.
  await enqueue('graph-invalidate', { arcId: arc.id }).catch(warn);
  await enqueue('arc-extract', { arcId: arc.id }).catch(warn);
}

/** Обработчики фоновых джоб (Фаза B — извлечение/граф, 🟡; вне крит. пути). */
function registerJobHandlers() {
  // Запечатанная арка → дешёвое саммари + voiceQuotes + триплеты.
  // После саммари — авто-скрытие: теперь у арки есть gist, прятать пласт безопасно.
  registerHandler('arc-extract', async (payload) => {
    const ok = await summarizeArc(payload.arcId);
    if (ok) await autoHideMaintain().catch(warn);
  });
  // Фаза C: allow-list (анти-галлюцинация) + дрейф-флаг → очищенный graph-merge.
  registerHandler('deep-extract', async (payload) => { await extractArc(payload); });
  // Триплеты → гибрид-мёрж в граф (provenance по арке).
  registerHandler('graph-merge', async (payload) => { await addTriples(payload); });
  // Откат вклада dirty-арки (каскад ограничен рёбрами с единственным источником).
  registerHandler('graph-invalidate', async (payload) => { await invalidateArc(payload.arcId); });
  // Фаза D: дорогой кросс-арочный аудит дрейфа (очередь дренит только в autonomous → платно ок).
  registerHandler('audit-expensive', async () => { await runAudit({ paidAllowed: true }); });
}

// --- Magic-wand / extensions menu button ---
// Wait for #extensionsMenu (ST builds it on body during init) instead of falling
// back to document.body; dedupe; native-style item (fa icon + non-wrapping label).
function addWandButton(tries = 0) {
  if (document.getElementById('cl-wand')) return;          // already added — don't duplicate
  const menu = document.getElementById('extensionsMenu');
  if (!menu) {                                             // container not ready yet → retry
    if (tries < 40) setTimeout(() => addWandButton(tries + 1), 250);
    else console.warn('[ChaoticLorebooks] extensionsMenu not found — wand button skipped');
    return;
  }
  const btn = document.createElement('div');
  btn.id = 'cl-wand';
  btn.className = 'list-group-item flex-container flexGap5 interactable';
  btn.tabIndex = 0;
  btn.title = t('ui.wandLabel');
  btn.innerHTML = `<div class="fa-fw fa-solid fa-hurricane extensionsMenuExtensionButton"></div><span>${t('ui.wandLabel')}</span>`;
  btn.addEventListener('click', () => toggleDrawer());
  menu.appendChild(btn);
}

// --- Звёзды избранного на каждом сообщении ---
function injectFavoriteStars() {
  document.querySelectorAll('#chat .mes').forEach((mesEl) => {
    if (mesEl.querySelector('.cl-star')) return;
    // Не звёздим системные/комменты/авторские заметки ST (класс .smallSysMes или
    // is_system="true") — звезда ломает их вёрстку/стилизацию (баг «пропадает css»).
    if (mesEl.classList.contains('smallSysMes') || mesEl.getAttribute('is_system') === 'true') return;
    const idx = Number(mesEl.getAttribute('mesid'));
    if (Number.isNaN(idx)) return;
    const star = document.createElement('div');
    star.className = 'cl-star' + (isFav(idx) ? ' cl-star-on' : '');
    star.textContent = '★';
    star.title = t('ui.starTitle');
    star.addEventListener('click', async () => {
      // Если внутри сообщения выделен текст — сохраняем ЦИТАТУ (часть), аддитивно.
      const sel = window.getSelection?.();
      const selText = sel && !sel.isCollapsed && mesEl.contains(sel.anchorNode)
        ? sel.toString().trim() : '';
      if (selText) {
        await addQuote(idx, selText);
        star.classList.add('cl-star-pulse');
        setTimeout(() => star.classList.remove('cl-star-pulse'), 400);
        globalThis.toastr?.success?.(t('toast.quoteSaved')); // toastr — window-глобал ST
      } else {
        const on = await toggleFavorite(idx);
        star.classList.toggle('cl-star-on', on);
      }
    });
    const buttons = mesEl.querySelector('.mes_buttons') || mesEl;
    buttons.prepend(star);
  });
}

// --- Плавающая кнопка «сохранить цитату» при выделении текста (надёжна на тач:
// тап по кнопке не теряет выделение, а текст кэшируем заранее) ---
function setupQuoteFab() {
  if (document.getElementById('cl-quote-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'cl-quote-fab';
  fab.className = 'cl-quote-fab cl-hidden';
  fab.textContent = `★ ${t('ui.quoteFab')}`;
  document.body.appendChild(fab);

  let cached = null;     // { idx, text }
  let hideTimer = null;

  const hide = () => { fab.classList.add('cl-hidden'); cached = null; };

  const update = () => {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { scheduleHide(); return; }
    const text = sel.toString().trim();
    // Ищем .mes от commonAncestorContainer (надёжнее, чем anchorNode.parentElement —
    // anchorNode может быть Element, или текстом в markdown-обёртке).
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const mesEl = el?.closest?.('#chat .mes');
    if (!text || !mesEl) { scheduleHide(); return; }
    const idx = Number(mesEl.getAttribute('mesid'));
    if (Number.isNaN(idx)) { scheduleHide(); return; }
    cached = { idx, text };
    const rect = range.getBoundingClientRect();
    // Появляемся ПОД выделением: сверху на мобиле живёт нативный Copy/Share-меню,
    // которое перекрывает FAB и мешает попасть пальцем.
    const top = Math.min(window.innerHeight - 48, Math.max(8, rect.bottom + 8));
    const left = Math.min(window.innerWidth - 130, Math.max(8, rect.left));
    fab.style.top = `${top}px`;
    fab.style.left = `${left}px`;
    fab.classList.remove('cl-hidden');
  };

  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 150); };

  document.addEventListener('selectionchange', () => { clearTimeout(hideTimer); hideTimer = setTimeout(update, 120); });
  // selectionchange задушен в некоторых браузерах — догоняем релизом курсора/пальца.
  document.addEventListener('mouseup', () => setTimeout(update, 0));
  document.addEventListener('touchend', () => setTimeout(update, 0), { passive: true });
  // Скролл прячет ТОЛЬКО если выделение уже сброшено — иначе теряем FAB на мобиле,
  // когда страница нудро двигается при тач-выделении.
  document.addEventListener('scroll', () => {
    const s = window.getSelection?.();
    if (!s || s.isCollapsed) hide();
  }, true);

  // Сохраняем на pointerdown — на мобиле тап по кнопке часто не доходит до click
  // (touchstart preventDefault душит синтез click в Chrome/Safari), плюс click
  // приходит после того, как палец/мышь уже сняли выделение.
  let firing = false;
  const doSave = async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (firing || !cached) return;
    firing = true;
    const { idx, text } = cached;
    hide();
    try {
      await addQuote(idx, text);
      globalThis.toastr?.success?.(t('toast.quoteSaved'));
      window.getSelection?.()?.removeAllRanges?.();
    } finally {
      setTimeout(() => { firing = false; }, 300);
    }
  };
  fab.addEventListener('pointerdown', doSave);
  // Фолбэк для браузеров без Pointer Events.
  fab.addEventListener('click', doSave);
}

// --- Слэш-команды ---
function registerSlashCommands(ctx) {
  // Сверено с ST: SlashCommandParser/SlashCommand живут на getContext(), а не в globalThis.
  const { SlashCommandParser, SlashCommand } = ctx;
  if (!SlashCommandParser || !SlashCommand) return;
  const p = getSettings().slashPrefix;

  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-tree`, callback: () => { toggleDrawer(); return ''; },
    helpString: t('cmd.tree'),
  }));
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-buffer`, callback: async () => { await decayTick(); toggleDrawer(); return ''; },
    helpString: t('cmd.buffer'),
  }));
  // Явная граница арки: запечатать открытую арку прямо сейчас + скрыть пласт.
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-arc`,
    callback: async () => {
      const sealed = await sealReady();
      if (sealed) { await afterSeal(sealed); globalThis.toastr?.success?.(t('toast.arcSealed', { id: sealed.id })); }
      else globalThis.toastr?.info?.(t('toast.nothingToSeal'));
      return '';
    },
    helpString: t('cmd.arc'),
  }));
  // Вернуть все авто-скрытые соо.
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-reveal`,
    callback: async () => { await autoHideRevealAll(); globalThis.toastr?.success?.(t('toast.hiddenRevealed')); return ''; },
    helpString: t('cmd.reveal'),
  }));
  // Включить/выключить расширение для ТЕКУЩЕГО чата (инъекция + фоновая память).
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-chat`,
    callback: async () => {
      const on = await toggleChatEnabled();
      globalThis.toastr?.[on ? 'success' : 'info']?.(on ? t('toast.chatOn') : t('toast.chatOff'));
      return '';
    },
    helpString: t('cmd.chat'),
  }));
  // Разовый backfill для поздно-включённого чата (Full = дешёвый ИИ / Light = без ИИ).
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-backfill`,
    callback: async () => { await runBackfillFlow(); return ''; },
    helpString: t('cmd.backfill'),
  }));
}

// Старт после готовности расширений.
const ctx = SillyTavern.getContext();
if (ctx.eventSource && ctx.event_types?.APP_READY) {
  ctx.eventSource.on(ctx.event_types.APP_READY, init);
} else {
  // фолбэк: небольшой таймаут, если событие недоступно
  setTimeout(init, 1500);
}

export { MODULE_NAME, getSettings, saveSettings };
