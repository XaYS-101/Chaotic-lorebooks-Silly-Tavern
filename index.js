// index.js — ТОНКИЙ оркестратор. Только init, проводка событий и регистрация
// точек входа. Вся логика — в модулях.

import { getSettings, saveSettings, MODULE_NAME } from './settings.js';
import { ensureBook } from './lorebook-service.js';
import { injectContext } from './injector.js';
import { decayTick } from './thought-buffer.js';
import { toggleFavorite, isFav, addQuote } from './favorites.js';
import { toggleDrawer, ensureDrawer } from './tree-ui.js';
import { renderSettingsPanel } from './settings-panel.js';
import { reset as resetScene } from './scene-detector.js';
import { resetCache as resetMemoryCache } from './memory-engine.js';
import { log as logActivity } from './activity-log.js';
// --- Фаза A — фундамент ---
import { onMessage as arcOnMessage, onEdit as arcOnEdit, reset as resetArc, sealReady } from './arc-segmenter.js';
import { maintain as autoHideMaintain, revealAll as autoHideRevealAll } from './auto-hide.js';
import { resumeAfterRestart, registerHandler, enqueue } from './job-queue.js';
import { noteUserEditing } from './lorebook-writer.js';
import { snapshot as backupSnapshot } from './backup.js';
// --- Фаза B — извлечение + граф + ярусы ---
import { summarizeArc } from './arc-summary.js';
import { addTriples, invalidateArc } from './knowledge-graph.js';
// --- Фаза C — глубокое извлечение (allow-list + значимость + дрейф) ---
import { extractArc } from './deep-extractor.js';
// --- Фаза D — дорогой кросс-арочный аудит дрейфа ---
import { runAudit, noteSettledForAudit } from './drift-monitor.js';
// --- branch-guard — изоляция памяти при форке чата ---
import { maybeHandleFork } from './branch-guard.js';
// --- global-reconciler — изоляция, когда наша книга активна глобально ---
import { maybeHandleGlobal } from './global-reconciler.js';
// --- i18n — EN/RU локализация UI/тостов/слэш-команд ---
import { t } from './i18n.js';

// --- Глобальный перехватчик промпта (имя совпадает с manifest) ---
// Вызывается ДО запроса генерации: тут мы собираем и вкладываем контекст.
globalThis.chaoticLorebooks_interceptor = async function (chat, contextSize, abort, type) {
  try {
    const s = getSettings();
    if (!s.enabled) return;
    await ensureBook(s);        // при первом запуске — попап выбора книги
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

  // Сброс UI при смене чата (метаданные буфера/избранного — свои на чат)
  eventSource.on(event_types.CHAT_CHANGED, () => {
    resetScene(); resetArc(); resetMemoryCache(); injectFavoriteStars();
    resumeAfterRestart();     // возобновить persisted-очередь нового чата
    maybeHandleFork().catch(warn); // ветка чата делит книгу с родителем? предложить форк
    maybeHandleGlobal().catch(warn); // книга, в которую пишем, активна глобально? предложить копию
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

  resumeAfterRestart();       // на старте — поднять незавершённые джобы
  console.log('[ChaoticLorebooks] initialized');
}

const warn = (e) => console.warn('[ChaoticLorebooks]', e);

/** Один устоявшийся ход: продвинуть арку; на запечатывании — скрыть пласт + снапшот + извлечение. */
async function onSettledTurn() {
  const s = getSettings();
  if (!s.enabled) return;
  const sealed = await arcOnMessage();
  if (sealed) {
    resetMemoryCache();                 // §4b: новая арка → кэш ядра устарел, пересоберём на сдвиге
    logActivity({ kind: 'arc-seal', arcId: sealed.id, detail: `#${sealed.start}–${sealed.end}` }).catch(warn);
    await autoHideMaintain();           // спрятать дозревший пласт
    if (s.backup?.enabled) backupSnapshot('arc-seal').catch(warn);
    // Фаза B: извлечение (саммари+граф) — фоновой джобой, только в autonomous.
    if (s.autonomous?.enabled) enqueue('arc-extract', { arcId: sealed.id }).catch(warn);
  }
  // Фаза D: раз в ~N устоявшихся ходов — дорогой кросс-арочный аудит (только autonomous).
  if (s.autonomous?.enabled && s.drift?.auditEnabled !== false && noteSettledForAudit()) {
    enqueue('audit-expensive', {}).catch(warn);
  }
}

/** Правка старого соо: гейт опечаток в арк-сегментере; существенная → откат+переизвлечение. */
async function onEditedTurn(idx) {
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
  registerHandler('arc-extract', async (payload) => { await summarizeArc(payload.arcId); });
  // Фаза C: allow-list (анти-галлюцинация) + дрейф-флаг → очищенный graph-merge.
  registerHandler('deep-extract', async (payload) => { await extractArc(payload); });
  // Триплеты → гибрид-мёрж в граф (provenance по арке).
  registerHandler('graph-merge', async (payload) => { await addTriples(payload); });
  // Откат вклада dirty-арки (каскад ограничен рёбрами с единственным источником).
  registerHandler('graph-invalidate', async (payload) => { await invalidateArc(payload.arcId); });
  // Фаза D: дорогой кросс-арочный аудит дрейфа (очередь дренит только в autonomous → платно ок).
  registerHandler('audit-expensive', async () => { await runAudit({ paidAllowed: true }); });
}

// --- Кнопка в «магической палочке» / панели расширений ---
function addWandButton() {
  const btn = document.createElement('div');
  btn.id = 'cl-wand';
  // extensionsMenuExtensionButton — нативный класс кнопок меню «магической палочки».
  btn.className = 'list-group-item flex-container flexGap5 interactable extensionsMenuExtensionButton';
  btn.innerHTML = `<span>🌀</span> ${t('ui.wandLabel')}`;
  btn.addEventListener('click', () => toggleDrawer());
  // Сверено с ST: контейнер меню расширений — #extensionsMenu.
  const menu = document.getElementById('extensionsMenu') || document.body;
  menu.appendChild(btn);
}

// --- Звёзды избранного на каждом сообщении ---
function injectFavoriteStars() {
  document.querySelectorAll('#chat .mes').forEach((mesEl) => {
    if (mesEl.querySelector('.cl-star')) return;
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
      if (sealed) { await autoHideMaintain(); globalThis.toastr?.success?.(t('toast.arcSealed', { id: sealed.id })); }
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
