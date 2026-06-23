// settings-panel.js — рендер панели настроек в раздел Extensions и
// двусторонняя привязка инпутов к настройкам. Всё 🟢.
// Держим index.js тонким — вся возня с панелью тут.

import { getSettings, saveSettings, applyMode, MODULE_NAME } from './settings.js';
import { t, localize } from './i18n.js';
import { deepPurgeAllChats, purgeCurrentChat, armBackstop } from './purge.js';
import { downloadDiagnostics } from './debug-trace.js';

// id инпута → путь в настройках + тип. Только РЕАЛЬНЫЕ v0-настройки.
const BINDINGS = [
  ['cl-enabled', 'enabled', 'bool'],
  ['cl-ui-language', 'uiLanguage', 'str'],
  ['cl-agent-source', 'agentSource', 'str'],
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
  ['cl-autohide-aftersummary', 'autoHide.afterSummary', 'bool'],
  ['cl-autohide-scope', 'autoHide.scope', 'str'],
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
  // Диагностика (ветка testing)
  ['cl-debug-enabled', 'debug.enabled', 'bool'],
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
  wireApiManager();          // кастомные эндпоинты (New/Delete/поля)
  wireSourceSwitch();        // ST-профиль ⇄ кастомный эндпоинт (показ блоков)
  wireDangerZone();          // 🗑 Clear all data
  wireDiagnostics();         // ⬇ Download diagnostics
  wireBackfill();            // ↻ Process existing messages

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

// --- Agent source: ST profile vs custom endpoint ---

// Show the selected source's block, hide the other.
function applySourceVisibility() {
  const src = getByPath(getSettings(), 'agentSource') || 'st';
  document.getElementById('cl-src-st')?.classList.toggle('cl-hidden', src !== 'st');
  document.getElementById('cl-src-custom')?.classList.toggle('cl-hidden', src !== 'custom');
}

// The generic binding persists agentSource on change; we just toggle the blocks.
function wireSourceSwitch() {
  applySourceVisibility();
  document.getElementById('cl-agent-source')?.addEventListener('change', () => applySourceVisibility());
}

// --- Custom endpoint manager (api.profiles) ---

function uid() {
  try { return crypto.randomUUID(); } catch { return `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`; }
}
function apiState() {
  const s = getSettings();
  if (!s.api || typeof s.api !== 'object') s.api = { profiles: [], activeProfileId: null };
  if (!Array.isArray(s.api.profiles)) s.api.profiles = [];
  return s.api;
}
function activeApiProfile() {
  const api = apiState();
  return api.profiles.find((p) => p && p.id === api.activeProfileId) || null;
}

// Rebuild #cl-api-select from api.profiles, select the active one, fill the fields.
function refreshApiSelect() {
  const sel = document.getElementById('cl-api-select');
  if (!sel) return;
  const api = apiState();
  sel.innerHTML = '';
  if (!api.profiles.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = t('set.api.none');
    sel.appendChild(o);
  } else {
    for (const p of api.profiles) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name || t('set.api.unnamed');
      sel.appendChild(o);
    }
  }
  if (api.activeProfileId && api.profiles.some((p) => p.id === api.activeProfileId)) {
    sel.value = api.activeProfileId;
  } else if (api.profiles.length) {
    api.activeProfileId = api.profiles[0].id;
    sel.value = api.activeProfileId;
    saveSettings();
  } else {
    api.activeProfileId = null;
  }
  fillApiFields();
}

// Load the active profile's name/url/key/model into the inputs (disabled when none).
function fillApiFields() {
  const p = activeApiProfile();
  const fields = {
    'cl-api-name': p?.name ?? '',
    'cl-api-url': p?.url ?? '',
    'cl-api-key': p?.key ?? '',
    'cl-api-model': p?.model ?? '',
  };
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = val;
    el.disabled = !p;
  }
  const del = document.getElementById('cl-api-del');
  if (del) del.disabled = !p;
}

function wireApiManager() {
  refreshApiSelect();

  document.getElementById('cl-api-select')?.addEventListener('change', (e) => {
    apiState().activeProfileId = e.target.value || null;
    saveSettings();
    fillApiFields();
  });

  document.getElementById('cl-api-new')?.addEventListener('click', () => {
    const api = apiState();
    const prof = { id: uid(), name: `${t('set.api.profileWord')} ${api.profiles.length + 1}`, url: '', key: '', model: '' };
    api.profiles.push(prof);
    api.activeProfileId = prof.id;
    saveSettings();
    refreshApiSelect();
    document.getElementById('cl-api-name')?.focus();
  });

  document.getElementById('cl-api-del')?.addEventListener('click', () => {
    const api = apiState();
    if (!api.activeProfileId) return;
    api.profiles = api.profiles.filter((p) => p.id !== api.activeProfileId);
    api.activeProfileId = api.profiles[0]?.id ?? null;
    saveSettings();
    refreshApiSelect();
  });

  // Field edits write to the active profile; a name change updates the select label.
  const fieldMap = { 'cl-api-name': 'name', 'cl-api-url': 'url', 'cl-api-key': 'key', 'cl-api-model': 'model' };
  for (const [id, key] of Object.entries(fieldMap)) {
    document.getElementById(id)?.addEventListener('input', () => {
      const p = activeApiProfile();
      if (!p) return;
      p[key] = document.getElementById(id).value;
      saveSettings();
      if (key === 'name') {
        const opt = [...(document.getElementById('cl-api-select')?.options || [])].find((o) => o.value === p.id);
        if (opt) opt.textContent = p.name || t('set.api.unnamed');
      }
    });
  }
}

// --- Опасная зона: полный сброс -------------------------------------------
function wireDangerZone() {
  document.getElementById('cl-clear-data')?.addEventListener('click', async () => {
    const c = SillyTavern.getContext();
    const POPUP_TYPE = c.POPUP_TYPE ?? {};
    const POPUP_RESULT = c.POPUP_RESULT ?? {};
    // Scope choice: this chat only vs every chat (deep purge).
    const wrap = document.createElement('div');
    wrap.className = 'cl-choose';
    wrap.innerHTML = `
      <h3>${t('popup.clear.title')}</h3>
      <p>${t('popup.clear.body')}</p>
      <label class="cl-choose-row">
        <input type="radio" name="cl-clear-scope" value="chat" checked>
        <span>${t('popup.clear.scopeChat')}</span>
      </label>
      <label class="cl-choose-row">
        <input type="radio" name="cl-clear-scope" value="all">
        <span>${t('popup.clear.scopeAll')}</span>
      </label>
      <p class="cl-hint">${t('popup.clear.scopeNote')}</p>`;
    let res;
    try {
      res = await c.callGenericPopup(wrap, POPUP_TYPE.CONFIRM ?? 2, '', {
        okButton: t('popup.clear.ok'), cancelButton: t('popup.cancel'),
      });
    } catch { return; }
    const affirmative = POPUP_RESULT.AFFIRMATIVE ?? 1;
    if (res !== affirmative && res !== true) return;
    const scope = wrap.querySelector('input[name="cl-clear-scope"]:checked')?.value || 'chat';
    await clearAllData(scope);
  });
}

// --- Backfill: разовый прогон по поздно-включённому чату ------------------
function wireBackfill() {
  document.getElementById('cl-backfill-run')?.addEventListener('click', async () => {
    try {
      const m = await import('../memory/backfill.js');
      await m.runBackfillFlow();
    } catch (e) {
      console.warn('[ChaoticLorebooks] backfill button:', e);
      globalThis.toastr?.error?.(t('toast.backfillNone'));
    }
  });
}

// --- Диагностика: выгрузка снимка состояния в JSON ------------------------
function wireDiagnostics() {
  document.getElementById('cl-diag-download')?.addEventListener('click', () => {
    const ok = downloadDiagnostics();
    if (ok) globalThis.toastr?.success?.(t('toast.diagSaved'));
    else globalThis.toastr?.error?.(t('toast.diagFailed'));
  });
}

// Reset settings to defaults + erase extension metadata. scope='chat' clears the
// current chat only; scope='all' sweeps every character chat and arms the backstop.
async function clearAllData(scope = 'chat') {
  const c = SillyTavern.getContext();

  // Clear the current chat before resetting settings (needs live chatMetadata).
  try { await purgeCurrentChat(); } catch (e) { console.warn('[ChaoticLorebooks] clear current failed:', e); }

  let deep = null;
  if (scope === 'all') {
    armBackstop();   // survives the settings wipe; scrubs remaining chats on open
    globalThis.toastr?.info?.(t('toast.purgeStart'));
    try { deep = await deepPurgeAllChats(); }
    catch (e) { console.warn('[ChaoticLorebooks] deep purge failed:', e); }
  }

  // Global settings → defaults.
  try { delete c.extensionSettings[MODULE_NAME]; } catch { /* fine */ }
  getSettings();
  saveSettings();

  // Re-read values into the panel.
  fillInputs();
  populateAgentProfiles();
  refreshApiSelect();
  applySourceVisibility();

  if (scope === 'all') {
    if (deep?.noNetwork) {
      globalThis.toastr?.warning?.(t('toast.purgeNoNetwork'));
    } else if (deep) {
      globalThis.toastr?.success?.(t('toast.purgeDone', { cleaned: deep.cleaned, failed: deep.failed }));
    }
  } else {
    globalThis.toastr?.success?.(t('toast.cleared'));
  }
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
