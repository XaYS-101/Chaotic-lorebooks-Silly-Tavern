// settings-panel.js — рендер панели настроек в раздел Extensions и
// двусторонняя привязка инпутов к настройкам. Всё 🟢.
// Держим index.js тонким — вся возня с панелью тут.

import { getSettings, saveSettings, applyMode, MODULE_NAME } from './settings.js';
import { t, localize } from './i18n.js';

// id инпута → путь в настройках + тип. Только РЕАЛЬНЫЕ v0-настройки.
const BINDINGS = [
  ['cl-enabled', 'enabled', 'bool'],
  ['cl-ui-language', 'uiLanguage', 'str'],
  ['cl-agent-profile', 'agentProfile', 'str'],
  ['cl-retrieval-mode', 'retrievalMode', 'str'],
  ['cl-agent-n', 'agentEveryNTurns', 'int'],
  ['cl-scene-sens', 'sceneDetector.sensitivity', 'float'],
  ['cl-ask', 'askOnFirstUse', 'bool'],
  ['cl-tpl', 'lorebookNameTemplate', 'str'],
  ['cl-buf-enabled', 'thoughtBuffer.enabled', 'bool'],
  ['cl-buf-limit', 'thoughtBuffer.limitEnabled', 'bool'],
  ['cl-buf-max', 'thoughtBuffer.maxItems', 'int'],
  ['cl-buf-decay', 'thoughtBuffer.decayPerTurn', 'int'],
  ['cl-resurface', 'resurfacing.enabled', 'bool'],
  ['cl-resurface-chance', 'resurfacing.chance', 'float'],
  ['cl-resurface-depth', 'resurfacing.depth', 'int'],
  // Фаза A — арки, авто-скрытие, бэкапы
  ['cl-autohide-enabled', 'autoHide.enabled', 'bool'],
  ['cl-autohide-window', 'autoHide.windowSize', 'int'],
  ['cl-autohide-keeptail', 'autoHide.keepTailFromSlab', 'int'],
  ['cl-arc-cap', 'arc.capMessages', 'int'],
  ['cl-arc-markers', 'arc.useMarkers', 'bool'],
  ['cl-arc-editthresh', 'arc.editDirtyThreshold', 'float'],
  ['cl-backup-enabled', 'backup.enabled', 'bool'],
  ['cl-backup-keep', 'backup.keepCount', 'int'],
  // Фаза B — ярусы памяти + граф
  ['cl-rec-enabled', 'recollection.enabled', 'bool'],
  ['cl-rec-max', 'recollection.maxGists', 'int'],
  ['cl-rec-quotes', 'recollection.voiceQuotesPerArc', 'int'],
  ['cl-rec-budget', 'recollection.budget', 'int'],
  ['cl-graph-enabled', 'graph.enabled', 'bool'],
  ['cl-graph-maxnodes', 'graph.maxNodes', 'int'],
  ['cl-graph-hops', 'graph.subgraphHops', 'int'],
  ['cl-graph-budget', 'graph.budget', 'int'],
  // Фаза C — глубокое извлечение + дрейф
  ['cl-deep-enabled', 'deepExtract.enabled', 'bool'],
  ['cl-deep-llmmode', 'deepExtract.llmMode', 'str'],
  ['cl-deep-pin', 'deepExtract.pinThreshold', 'float'],
  ['cl-drift-enabled', 'drift.cheapEnabled', 'bool'],
  ['cl-drift-audit', 'drift.auditEnabled', 'bool'],
  ['cl-drift-audit-n', 'drift.auditEveryNMessages', 'int'],
  // Фаза D — глобальный бюджет контекста
  ['cl-cb-enabled', 'contextBudget.enabled', 'bool'],
  ['cl-cb-target', 'contextBudget.target', 'int'],
  ['cl-cb-autoreview', 'contextBudget.autoReview', 'bool'],
  // Фаза D §4b — двухстадийный конвейер (Stage-1 движок памяти)
  ['cl-pipeline-enabled', 'pipeline.enabled', 'bool'],
  ['cl-pipeline-compose', 'pipeline.composeLLM', 'bool'],
  // Фаза D — лента активности + таймлайн
  ['cl-timeline-enabled', 'timeline.enabled', 'bool'],
  ['cl-activity-enabled', 'activityLog.enabled', 'bool'],
  ['cl-activity-max', 'activityLog.maxEntries', 'int'],
  // branch-guard — изоляция книги на форке чата
  ['cl-branch-enabled', 'branch.enabled', 'bool'],
  ['cl-branch-ask', 'branch.askOnFork', 'bool'],
  ['cl-branch-action', 'branch.defaultAction', 'str'],
  // global-reconciler — изоляция, когда книга активна глобально
  ['cl-global-enabled', 'globalReconciler.enabled', 'bool'],
  ['cl-global-ask', 'globalReconciler.askOnDetected', 'bool'],
  ['cl-global-action', 'globalReconciler.defaultAction', 'str'],
];

// Подсказки режима — через i18n (ключи set.hint.*), чтобы EN/RU совпадали.
const MODE_HINT_KEY = { lite: 'set.hint.lite', balanced: 'set.hint.balanced', autonomous: 'set.hint.autonomous' };
const modeHint = (mode) => (MODE_HINT_KEY[mode] ? t(MODE_HINT_KEY[mode]) : '');

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setByPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const tgt = keys.reduce((o, k) => (o[k] ??= {}), obj);
  tgt[last] = val;
}
function coerce(type, el) {
  if (type === 'bool') return el.checked;
  if (type === 'int') return parseInt(el.value, 10) || 0;
  if (type === 'float') return parseFloat(el.value) || 0;
  return el.value;
}

export async function renderSettingsPanel() {
  let html;
  try {
    // Грузим settings.html ОТНОСИТЕЛЬНО самого модуля (import.meta.url), а НЕ по
    // хардкод-имени папки: ST ставит расширение в third-party/<имя-репо>
    // (= Chaotic-lorebooks-Silly-Tavern), а не «chaotic-lorebooks», поэтому прежний
    // путь ломался и панель была пустой. settings-panel.js лежит в src/core/ →
    // settings.html в корне расширения = на два уровня выше.
    html = await (await fetch(new URL('../../settings.html', import.meta.url))).text();
  } catch (e) {
    console.warn('[ChaoticLorebooks] settings.html load failed:', e);
    return;
  }
  const container = document.getElementById('extensions_settings2')
    || document.getElementById('extensions_settings');
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  container.appendChild(wrap);

  localize(wrap);   // перевести статичные [data-cl-i18n] под текущий язык
  bindInputs();
  populateAgentProfiles();   // заполнить список профилей подключения (после bindInputs)
  wireProfileButtons();      // Refresh / + New profile
  wireDangerZone();          // 🗑 Clear all data

  // Смена языка интерфейса → перелокализовать панель «вживую» (без перезагрузки).
  // Значение уже сохранено generic-биндингом выше; getLang сразу видит новое.
  document.getElementById('cl-ui-language')?.addEventListener('change', () => {
    localize(wrap);
    populateAgentProfiles();  // дефолтная опция «(текущее подключение)» — через t(), перелокализуем
    const modeEl = document.getElementById('cl-mode');
    const hintEl = document.getElementById('cl-mode-hint');
    if (modeEl && hintEl) hintEl.textContent = modeHint(modeEl.value);
  });
}

// --- Профили подключения (двухмодельная схема) -----------------------------
// Профили хранит Connection Manager в extensionSettings.connectionManager.profiles
// (массив { id:UUID, name, mode, ... }); sendRequest идентифицирует профиль по ID.
function getConnectionProfiles() {
  try {
    const cm = SillyTavern.getContext()?.extensionSettings?.connectionManager;
    return Array.isArray(cm?.profiles) ? cm.profiles : [];
  } catch { return []; }
}

/** Перестроить #cl-agent-profile из сохранённых профилей ST, сохранив выбор. */
function populateAgentProfiles() {
  const sel = document.getElementById('cl-agent-profile');
  if (!sel) return;
  const stored = getByPath(getSettings(), 'agentProfile') || '';

  sel.innerHTML = '';
  const def = document.createElement('option');     // «(текущее подключение)» = пустая строка
  def.value = '';
  def.textContent = t('set.agent.profileDefault');
  sel.appendChild(def);
  for (const p of getConnectionProfiles()) {
    const id = p?.id ?? p?.name;
    if (!id) continue;
    const o = document.createElement('option');
    o.value = String(id);
    o.textContent = p?.name || String(id);
    sel.appendChild(o);
  }

  // Восстановить выбор; если сохранённый профиль исчез — откат на текущее подключение.
  sel.value = stored;
  if (sel.value !== stored) {
    sel.value = '';
    setByPath(getSettings(), 'agentProfile', '');
    saveSettings();
  }
}

function wireProfileButtons() {
  document.getElementById('cl-profile-refresh')
    ?.addEventListener('click', () => populateAgentProfiles());
  document.getElementById('cl-profile-new')
    ?.addEventListener('click', () => createProfile().catch((e) =>
      console.warn('[ChaoticLorebooks] createProfile failed:', e)));
}

/** «+ New profile» — на свой страх и риск: снимок ТЕКУЩЕГО подключения в новый
 *  профиль через нативную команду ST /profile-create (она же покажет свой UI). */
async function createProfile() {
  const c = SillyTavern.getContext();
  const POPUP_TYPE = c.POPUP_TYPE ?? {};
  let name;
  try {
    name = await c.callGenericPopup(t('popup.profileName.title'), POPUP_TYPE.INPUT ?? 3, '', {
      okButton: t('popup.ok'), cancelButton: t('popup.cancel'),
    });
  } catch { return; }
  if (name === false || name == null) return;            // отмена
  name = String(name).trim();
  if (!name) return;

  // Имя как один аргумент команды: экранируем кавычки и оборачиваем.
  const arg = `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  try {
    const run = c.executeSlashCommandsWithOptions || c.executeSlashCommands;
    if (!run) throw new Error('no slash-command runner');
    await run.call(c, `/profile-create ${arg}`);
  } catch (e) {
    console.warn('[ChaoticLorebooks] /profile-create failed:', e);
    globalThis.toastr?.error?.(t('toast.profileCreateFail'));
    return;
  }

  // Подхватить только что созданный профиль (он становится selectedProfile).
  populateAgentProfiles();
  const sel = document.getElementById('cl-agent-profile');
  const newId = c?.extensionSettings?.connectionManager?.selectedProfile;
  if (sel && newId && [...sel.options].some((o) => o.value === String(newId))) {
    sel.value = String(newId);
    setByPath(getSettings(), 'agentProfile', String(newId));
    saveSettings();
  }
  globalThis.toastr?.success?.(t('toast.profileCreated'));
}

// --- Опасная зона: полный сброс -------------------------------------------
function wireDangerZone() {
  document.getElementById('cl-clear-data')?.addEventListener('click', async () => {
    const c = SillyTavern.getContext();
    const POPUP_TYPE = c.POPUP_TYPE ?? {};
    const POPUP_RESULT = c.POPUP_RESULT ?? {};
    const wrap = document.createElement('div');
    wrap.innerHTML = `<h3>${t('popup.clear.title')}</h3><p>${t('popup.clear.body')}</p>`;
    let res;
    try {
      res = await c.callGenericPopup(wrap, POPUP_TYPE.CONFIRM ?? 2, '', {
        okButton: t('popup.clear.ok'), cancelButton: t('popup.cancel'),
      });
    } catch { return; }
    const affirmative = POPUP_RESULT.AFFIRMATIVE ?? 1;
    if (res !== affirmative && res !== true) return;
    await clearAllData();
  });
}

/** Сбросить настройки к дефолтам + стереть метаданные расширения ТЕКУЩЕГО чата. */
async function clearAllData() {
  const c = SillyTavern.getContext();
  // 1) настройки (глобальные) → дефолты
  try { delete c.extensionSettings[MODULE_NAME]; } catch { /* нет — и ладно */ }
  getSettings();   // переинициализировать дефолты
  saveSettings();
  // 2) метаданные ТЕКУЩЕГО чата с префиксом chaoticLorebooks_ (native world_info НЕ трогаем)
  try {
    const meta = c.chatMetadata;
    if (meta) {
      for (const k of Object.keys(meta)) {
        if (k.startsWith('chaoticLorebooks_')) delete meta[k];
      }
      await c.saveMetadata?.();
    }
  } catch (e) {
    console.warn('[ChaoticLorebooks] clear metadata failed:', e);
  }
  // 3) перечитать значения в панель
  fillInputs();
  populateAgentProfiles();
  globalThis.toastr?.success?.(t('toast.cleared'));
}

// Только ЗАПОЛНИТЬ инпуты текущими значениями (без навешивания слушателей).
// Вызывается из bindInputs (один раз) и после смены режима (режим меняет
// зависимые поля). НЕ навешивает слушатели → их нельзя задублировать.
function fillInputs() {
  const s = getSettings();
  for (const [id, path, type] of BINDINGS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const val = getByPath(s, path);
    if (type === 'bool') el.checked = !!val; else el.value = val ?? '';
  }
  const modeEl = document.getElementById('cl-mode');
  const hintEl = document.getElementById('cl-mode-hint');
  if (modeEl) {
    modeEl.value = s.mode;
    if (hintEl) hintEl.textContent = modeHint(s.mode);
  }
}

function bindInputs() {
  fillInputs();   // проставить значения один раз

  // навесить слушатели РОВНО ОДИН раз на свежий DOM панели
  for (const [id, path, type] of BINDINGS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      setByPath(getSettings(), path, coerce(type, el));
      saveSettings();
    });
  }

  // режим
  const modeEl = document.getElementById('cl-mode');
  const hintEl = document.getElementById('cl-mode-hint');
  if (modeEl) {
    modeEl.addEventListener('change', () => {
      applyMode(modeEl.value);
      if (hintEl) hintEl.textContent = modeHint(modeEl.value);
      // режим поменял зависимые поля → ТОЛЬКО перечитать значения, не перевешивать слушатели
      fillInputs();
    });
  }
}
