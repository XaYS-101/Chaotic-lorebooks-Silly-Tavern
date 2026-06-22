// settings-panel.js — рендер панели настроек в раздел Extensions и
// двусторонняя привязка инпутов к настройкам. Всё 🟢.
// Держим index.js тонким — вся возня с панелью тут.

import { getSettings, saveSettings, applyMode } from './settings.js';
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
  const ctx = SillyTavern.getContext();
  let html;
  try {
    html = await ctx.renderExtensionTemplateAsync('third-party/chaotic-lorebooks', 'settings', {});
  } catch {
    // ⚠FLAG: если шаблонизатор недоступен — тянем файл напрямую.
    html = await (await fetch('/scripts/extensions/third-party/chaotic-lorebooks/settings.html')).text();
  }
  const container = document.getElementById('extensions_settings2')
    || document.getElementById('extensions_settings');
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  container.appendChild(wrap);

  localize(wrap);   // перевести статичные [data-cl-i18n] под текущий язык
  bindInputs();

  // Смена языка интерфейса → перелокализовать панель «вживую» (без перезагрузки).
  // Значение уже сохранено generic-биндингом выше; getLang сразу видит новое.
  document.getElementById('cl-ui-language')?.addEventListener('change', () => {
    localize(wrap);
    const modeEl = document.getElementById('cl-mode');
    const hintEl = document.getElementById('cl-mode-hint');
    if (modeEl && hintEl) hintEl.textContent = modeHint(modeEl.value);
  });
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
