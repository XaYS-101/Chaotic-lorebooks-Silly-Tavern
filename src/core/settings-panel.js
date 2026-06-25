// settings-panel.js — renders the settings panel in the Extensions section and
// two-way binds inputs to settings. All 🟢.
// Keeps index.js thin — all panel wiring lives here.

import { getSettings, saveSettings, applyMode, MODULE_NAME } from './settings.js';
import { t, localize } from './i18n.js';
import { deepPurgeAllChats, purgeCurrentChat, armBackstop } from './purge.js';
import { downloadDiagnostics } from './debug-trace.js';
import { seedBaselineIfNeeded } from '../memory/arc-segmenter.js';
import { maybeOfferBackfill } from '../memory/backfill.js';

// input id → settings path + type. Only REAL v0 settings.
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
  // Phase A — arcs, auto-hide, backups
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
  // Phase B — memory tiers + graph
  ['cl-rec-enabled', 'recollection.enabled', 'bool'],
  ['cl-rec-max', 'recollection.maxGists', 'int'],
  ['cl-rec-quotes', 'recollection.voiceQuotesPerArc', 'int'],
  ['cl-rec-budget', 'recollection.budget', 'int'],
  ['cl-graph-enabled', 'graph.enabled', 'bool'],
  ['cl-graph-maxnodes', 'graph.maxNodes', 'int'],
  ['cl-graph-hops', 'graph.subgraphHops', 'int'],
  ['cl-graph-budget', 'graph.budget', 'int'],
  // Phase C — deep extraction + drift
  ['cl-deep-enabled', 'deepExtract.enabled', 'bool'],
  ['cl-deep-llmmode', 'deepExtract.llmMode', 'str'],
  ['cl-deep-pin', 'deepExtract.pinThreshold', 'float'],
  ['cl-drift-enabled', 'drift.cheapEnabled', 'bool'],
  ['cl-drift-audit', 'drift.auditEnabled', 'bool'],
  ['cl-drift-audit-n', 'drift.auditEveryNMessages', 'int'],
  // Phase D — global context budget
  ['cl-cb-enabled', 'contextBudget.enabled', 'bool'],
  ['cl-cb-target', 'contextBudget.target', 'int'],
  ['cl-cb-autoreview', 'contextBudget.autoReview', 'bool'],
  // Phase D §4b — two-stage pipeline (Stage-1 memory engine)
  ['cl-pipeline-enabled', 'pipeline.enabled', 'bool'],
  ['cl-pipeline-compose', 'pipeline.composeLLM', 'bool'],
  // Phase D — activity feed + timeline
  ['cl-timeline-enabled', 'timeline.enabled', 'bool'],
  ['cl-activity-enabled', 'activityLog.enabled', 'bool'],
  ['cl-activity-max', 'activityLog.maxEntries', 'int'],
  // branch-guard — book isolation on chat fork
  ['cl-branch-enabled', 'branch.enabled', 'bool'],
  ['cl-branch-ask', 'branch.askOnFork', 'bool'],
  ['cl-branch-action', 'branch.defaultAction', 'str'],
  // global-reconciler — isolation when the book is globally active
  ['cl-global-enabled', 'globalReconciler.enabled', 'bool'],
  ['cl-global-ask', 'globalReconciler.askOnDetected', 'bool'],
  ['cl-global-action', 'globalReconciler.defaultAction', 'str'],
  // Diagnostics (testing branch)
  ['cl-debug-enabled', 'debug.enabled', 'bool'],
];

// Mode hints — via i18n (set.hint.* keys) so EN/RU stay in sync.
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
  // Empty/invalid numeric field → undefined so the caller keeps the current value
  // (an empty box must not silently become 0).
  if (type === 'int' || type === 'float') {
    const raw = String(el.value).trim();
    if (raw === '') return undefined;
    const n = type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return el.value;
}

export async function renderSettingsPanel() {
  let html;
  try {
    // Load settings.html RELATIVE to the module itself (import.meta.url), NOT by a
    // hardcoded folder name: ST installs the extension under third-party/<repo-name>
    // (= Chaotic-lorebooks-Silly-Tavern), not "chaotic-lorebooks", so the old path
    // broke and the panel was empty. settings-panel.js is in src/core/ → settings.html
    // at the extension root is two levels up.
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

  localize(wrap);   // translate static [data-cl-i18n] for the current language
  bindInputs();
  populateAgentProfiles();   // fill the connection-profile list (after bindInputs)
  wireProfileButtons();      // Refresh / + New profile
  wireApiManager();          // custom endpoints (New/Delete/fields)
  wireSourceSwitch();        // ST profile ⇄ custom endpoint (block visibility)
  wireDangerZone();          // 🗑 Clear all data
  wireDiagnostics();         // ⬇ Download diagnostics
  wireBackfill();            // ↻ Process existing messages

  // UI language change → re-localize the panel live (no reload). The value is
  // already saved by the generic binding above; getLang sees it immediately.
  document.getElementById('cl-ui-language')?.addEventListener('change', () => {
    localize(wrap);
    populateAgentProfiles();  // the default "(current connection)" option uses t() — re-localize
    const modeEl = document.getElementById('cl-mode');
    const hintEl = document.getElementById('cl-mode-hint');
    if (modeEl && hintEl) hintEl.textContent = modeHint(modeEl.value);
  });
}

// --- Connection profiles (two-model scheme) --------------------------------
// Profiles are stored by Connection Manager in extensionSettings.connectionManager.profiles
// (array { id:UUID, name, mode, ... }); sendRequest identifies a profile by ID.
function getConnectionProfiles() {
  try {
    const cm = SillyTavern.getContext()?.extensionSettings?.connectionManager;
    return Array.isArray(cm?.profiles) ? cm.profiles : [];
  } catch { return []; }
}

/** Rebuild #cl-agent-profile from saved ST profiles, preserving the selection. */
function populateAgentProfiles() {
  const sel = document.getElementById('cl-agent-profile');
  if (!sel) return;
  const stored = getByPath(getSettings(), 'agentProfile') || '';

  sel.innerHTML = '';
  const def = document.createElement('option');     // "(current connection)" = empty string
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

  // Restore the selection; if the saved profile is gone, fall back to current connection.
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

/** "+ New profile" — at your own risk: snapshot the CURRENT connection into a new
 *  profile via ST's native /profile-create command (which shows its own UI). */
async function createProfile() {
  const c = SillyTavern.getContext();
  const POPUP_TYPE = c.POPUP_TYPE ?? {};
  let name;
  try {
    name = await c.callGenericPopup(t('popup.profileName.title'), POPUP_TYPE.INPUT ?? 3, '', {
      okButton: t('popup.ok'), cancelButton: t('popup.cancel'),
    });
  } catch { return; }
  if (name === false || name == null) return;            // cancelled
  name = String(name).trim();
  if (!name) return;

  // Name as a single command argument: escape quotes and wrap.
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

  // Pick up the just-created profile (it becomes selectedProfile).
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

// --- Danger zone: full reset ----------------------------------------------
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

// --- Backfill: one-time run over a late-enabled chat ----------------------
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

// --- Diagnostics: export a state snapshot as JSON -------------------------
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

  // Bug #3: after in-place purge, re-seed baseline and re-offer backfill.
  // CHAT_CHANGED doesn't fire on in-place reset, so the banner would stay
  // missing until the user switches chats away and back.
  if (scope === 'chat') {
    try {
      const s = getSettings();
      await seedBaselineIfNeeded(s.backfill?.threshold ?? 10);
      await maybeOfferBackfill();
    } catch (e) { console.warn('[ChaoticLorebooks] re-seed after clear failed:', e); }
  }

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

// Only FILL inputs with current values (no listeners attached). Called from
// bindInputs (once) and after a mode change (mode alters dependent fields).
// Does NOT attach listeners → they can't be duplicated.
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
  fillInputs();   // set values once

  // attach listeners EXACTLY ONCE on the fresh panel DOM
  for (const [id, path, type] of BINDINGS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      const val = coerce(type, el);
      if (val === undefined) { fillInputs(); return; }   // empty/invalid → restore shown value
      setByPath(getSettings(), path, val);
      saveSettings();
    });
  }

  // mode
  const modeEl = document.getElementById('cl-mode');
  const hintEl = document.getElementById('cl-mode-hint');
  if (modeEl) {
    modeEl.addEventListener('change', () => {
      applyMode(modeEl.value);
      if (hintEl) hintEl.textContent = modeHint(modeEl.value);
      // mode changed dependent fields → ONLY re-read values, don't re-attach listeners
      fillInputs();
    });
  }
}
