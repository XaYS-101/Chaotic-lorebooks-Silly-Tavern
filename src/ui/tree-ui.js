// tree-ui.js — выезжающее дерево (mobile-first). Фаза B: 3 вкладки вместо 4
// (анти-перегруз UI, SPEC §0.8):
//   Memory   — ИИ-память: Воспоминания (ярус 2) + Лорбук-дерево + Арки + добавить заметку
//   Saved    — избранные соо и цитаты в одной вкладке (фильтр-чипы)
//   Thoughts — буфер мыслей (ярус 1)
// Под шапкой — компактная строка статуса (режим · книга · арки · узлы графа).
//
// Метки: 🟢. Цвета берём из темы ST (CSS-переменные), не хардкодим.

import { t } from '../core/i18n.js';
import { buildTree } from '../lorebook/tree-store.js';
import { getBuffer, removeItem as removeBufItem } from '../memory/thought-buffer.js';
import {
  getFavorites, removeFavorite, editText, setEnabled, setPinned, setMode, saveAsEntry,
} from '../inject/favorites.js';
import { getSettings, saveSettings } from '../core/settings.js';
import { getBoundBookName, ensureBook } from '../lorebook/lorebook-service.js';
import { isChatEnabled, toggleChatEnabled } from '../core/chat-state.js';
import { getSealedArcs, sealReady, getArc } from '../memory/arc-segmenter.js';
import { maintain as autoHideMaintain, revealAll as autoHideRevealAll } from '../memory/auto-hide.js';
// afterSeal живёт в оркестраторе (index.js): активность+снапшот+саммари+скрытие одним местом.
// Живой биндинг, зовётся только в обработчике клика → циклический импорт безопасен.
import { afterSeal } from '../../index.js';
import {
  getGists, setActive as setRecActive, bulkSetArc, removeGist,
} from '../memory/recollection.js';
import { getStats as graphStats } from '../memory/knowledge-graph.js';
import { backfillAvailable, getBackfillInfo, runBackfillFlow } from '../memory/backfill.js';
import { getDriftFlags, resolveDriftFlag } from '../memory/deep-extractor.js';
import { runAudit } from '../memory/drift-monitor.js';
import { getLastReport, autoReview, review } from '../memory/context-budget.js';
import { clearLog as clearActivityLog } from '../memory/activity-log.js';
import { buildTimeline, restoreTo, snapshotNow } from '../memory/timeline.js';

let drawerEl = null;
let savedFilter = 'all';   // all | message | quote

export function ensureDrawer() {
  if (drawerEl) return drawerEl;
  drawerEl = document.createElement('div');
  drawerEl.id = 'cl-drawer';
  drawerEl.className = 'cl-drawer cl-hidden';
  drawerEl.innerHTML = `
    <div class="cl-drawer-head">
      <span>🌀 Chaotic Lorebooks</span>
      <div class="cl-head-btns">
        <button class="cl-help" title="${ta('ui.legend.title')}">?</button>
        <button class="cl-close" title="${ta('ui.close')}">✕</button>
      </div>
    </div>
    <div class="cl-status" id="cl-status"></div>
    <div class="cl-tabs">
      <button data-tab="memory" class="cl-tab cl-tab-active">${t('ui.tab.memory')}</button>
      <button data-tab="saved" class="cl-tab">${t('ui.tab.saved')}</button>
      <button data-tab="thoughts" class="cl-tab">${t('ui.tab.thoughts')}</button>
    </div>
    <div class="cl-body"></div>`;
  document.body.appendChild(drawerEl);
  drawerEl.querySelector('.cl-close').addEventListener('click', hideDrawer);
  drawerEl.querySelector('.cl-help')?.addEventListener('click', showLegend);
  drawerEl.querySelectorAll('.cl-tab').forEach((tab) =>
    tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  return drawerEl;
}

// Легенда условных обозначений (эмодзи) — попап со списком символов и значений.
function showLegend() {
  const c = SillyTavern.getContext();
  const rows = [
    ['▶ / ⏸', t('ui.legend.chat')],
    ['★', t('ui.legend.message')],
    ['❝', t('ui.legend.quote')],
    ['👁 / 🚫', t('ui.legend.enabled')],
    ['📌', t('ui.legend.pin')],
    ['📚', t('ui.legend.promote')],
    ['✕', t('ui.legend.remove')],
    ['permanent · chance · relevant', t('ui.legend.modes')],
    ['★ · • · ·', t('ui.legend.significance')],
    ['📸 / ⏪', t('ui.legend.restore')],
  ];
  const wrap = document.createElement('div');
  wrap.className = 'cl-choose cl-legend';
  wrap.innerHTML = `<h3>${escapeHtml(t('ui.legend.title'))}</h3>`
    + rows.map(([sym, desc]) =>
      `<div class="cl-legend-row"><span class="cl-legend-sym">${sym}</span><span>${escapeHtml(desc)}</span></div>`).join('');
  try { c.callGenericPopup(wrap, c.POPUP_TYPE?.TEXT ?? 1, '', { okButton: t('ui.close') }); } catch { /* no-op */ }
}

export async function toggleDrawer() {
  ensureDrawer();
  if (drawerEl.classList.contains('cl-hidden')) {
    drawerEl.classList.remove('cl-hidden');
    await switchTab('memory');
  } else { hideDrawer(); }
}

function hideDrawer() { drawerEl?.classList.add('cl-hidden'); }

function setActiveTab(name) {
  drawerEl.querySelectorAll('.cl-tab').forEach((tab) =>
    tab.classList.toggle('cl-tab-active', tab.dataset.tab === name));
}

async function switchTab(name) {
  setActiveTab(name);
  const body = drawerEl.querySelector('.cl-body');
  if (name === 'memory') body.innerHTML = await renderMemoryHtml();
  else if (name === 'saved') body.innerHTML = renderSavedHtml();
  else body.innerHTML = renderBufferHtml();
  wireBody(body, name);
  refreshStatus();   // async, не блокирует
}

// --- Строка статуса ---
async function refreshStatus() {
  const el = drawerEl?.querySelector('#cl-status');
  if (!el) return;
  const s = getSettings();
  const book = getBoundBookName();
  const arcs = getSealedArcs().length;
  const rep = getLastReport();
  const memSeg = (s.contextBudget?.enabled && rep && rep.target)
    ? `<span title="${ta('ui.title.budgetUsed')}">🧮 ${budgetPct(rep)}%</span>` : '';
  const on = isChatEnabled();
  const chatPill = `<span id="cl-chat-toggle" class="cl-chat-pill${on ? '' : ' cl-chat-off'}" title="${ta('ui.chat.title')}">${on ? '▶' : '⏸'}</span>`;
  el.innerHTML = `${chatPill}
    <span>${escapeHtml(s.mode)}</span>
    <span>${book ? '📖 ✓' : '📖 ✗'}</span>
    <span>${t('ui.status.arcs', { n: arcs })}</span>
    <span id="cl-status-graph">· …</span>
    ${memSeg}`;
  // пер-чатовый тумблер: клик → переключить и перерисовать статус
  el.querySelector('#cl-chat-toggle')?.addEventListener('click', async () => {
    const nowOn = await toggleChatEnabled();
    globalThis.toastr?.[nowOn ? 'success' : 'info']?.(nowOn ? t('toast.chatOn') : t('toast.chatOff'));
    refreshStatus();
  });
  // узлы графа читаются из книги (async) — дольём отдельно
  try {
    const { nodes } = await graphStats();
    const g = el.querySelector('#cl-status-graph');
    if (g) g.textContent = t('ui.status.nodes', { n: nodes });
  } catch {
    const g = el.querySelector('#cl-status-graph');
    if (g) g.textContent = '';
  }
}

// --- Вкладка Memory ---
async function renderMemoryHtml() {
  return `
    ${renderBackfillBanner()}
    ${renderBudgetSection()}
    ${renderRecollectionsSection()}
    ${await renderTreeSection()}
    ${renderArcsSection()}
    ${renderDriftSection()}
    ${renderTimelineSection()}
    <div class="cl-addnote">
      <input id="cl-note-input" type="text" placeholder="${ta('ui.note.placeholder')}">
      <button id="cl-note-add">${t('ui.btn.addNote')}</button>
    </div>`;
}

function renderBackfillBanner() {
  if (!backfillAvailable()) return '';
  const { count } = getBackfillInfo();
  return `<div class="cl-backfill-banner">
    <span class="cl-backfill-banner-text">${t('backfill.banner', { n: count })}</span>
    <button id="cl-backfill-banner-btn" class="cl-backfill-banner-btn">${t('backfill.popup.process')}</button>
  </div>`;
}

function renderRecollectionsSection() {
  const gists = getGists();
  const active = gists.filter((g) => g.active !== false).length;
  let inner;
  if (!gists.length) {
    inner = `<p class="cl-empty">${t('ui.rec.empty')}</p>`;
  } else {
    const gistStart = (g) => getArc(g.arcId)?.start ?? g.arcId ?? 0; // хронологический порядок (по началу арки)
    inner = gists.slice().sort((a, b) => gistStart(a) - gistStart(b)).map((g) => `
      <div class="cl-gist ${g.active === false ? 'cl-disabled' : ''}" data-id="${g.id}">
        <div class="cl-gist-text">${escapeHtml(g.gist)}</div>
        ${(g.voiceQuotes || []).map((q) => `<div class="cl-gist-quote">» ${escapeHtml(q)}</div>`).join('')}
        <div class="cl-gist-actions">
          <span class="cl-weight">${t('ui.label.arc', { id: g.arcId ?? '?' })}</span>
          <button data-rec-toggle="${g.id}" title="${g.active === false ? t('ui.title.recall') : t('ui.btn.forget')}">${g.active === false ? '🚫' : '👁'}</button>
          <button data-rec-rm="${g.id}" class="cl-rm" title="${ta('ui.title.delete')}">✕</button>
        </div>
      </div>`).join('');
  }
  return section(t('ui.sec.recollections'), t('ui.rec.sub', { n: active }), inner, true);
}

async function renderTreeSection() {
  const root = await buildTree();
  const node = (n, depth) => {
    let html = '';
    for (const [name, child] of n.children) {
      html += `<details class="cl-node" ${depth < 1 ? 'open' : ''}>
        <summary>${escapeHtml(name)} <span class="cl-count">${child.entries.length || ''}</span></summary>`;
      for (const e of child.entries) {
        html += `<div class="cl-entry" title="${escapeHtml(e.content).slice(0, 200)}">${escapeHtml(e.title)}</div>`;
      }
      html += node(child, depth + 1);
      html += `</details>`;
    }
    return html;
  };
  const inner = node(root, 0) || `<p class="cl-empty">${t('ui.tree.empty')}</p>`;
  return section(t('ui.sec.tree'), '', inner, true);
}

function renderArcsSection() {
  const arcs = getSealedArcs();
  const controls = `<div class="cl-arc-controls">
      <button id="cl-arc-seal">${t('ui.btn.sealNow')}</button>
      <button id="cl-arc-reveal">${t('ui.btn.revealHidden')}</button>
    </div>`;
  let inner;
  if (!arcs.length) {
    inner = controls + `<p class="cl-empty">${t('ui.arcs.empty')}</p>`;
  } else {
    inner = controls + arcs.slice().sort((a, b) => (a.start - b.start) || (a.id - b.id)).map((a) => `
      <div class="cl-arc" data-arc="${a.id}">
        <span class="cl-arc-title">${t('ui.arc', { id: a.id })} ${sigBadge(a)}<span class="cl-weight">#${a.start}–${a.end}</span>
          ${a.dirty ? `<span class="cl-dirty">${t('ui.dirty')}</span>` : ''}</span>
        ${a.summaryGist ? `<div class="cl-arc-gist">${escapeHtml(a.summaryGist)}</div>` : ''}
        <button data-arc-forget="${a.id}" class="cl-arc-forget" title="${ta('ui.title.forgetArc')}">${t('ui.btn.forget')}</button>
      </div>`).join('');
  }
  return section(t('ui.sec.arcs'), t('ui.arcs.sub', { n: arcs.length }), inner, false);
}

/** Бейдж значимости арки (Фаза C). Нет значения (deep-extract выкл) → пусто. */
function sigBadge(a) {
  if (typeof a.significance !== 'number') return '';
  const s = getSettings();
  const hi = s.deepExtract?.pinThreshold ?? 0.7;
  const lo = s.deepExtract?.lowThreshold ?? 0.3;
  if (a.significance >= hi) return `<span class="cl-sig cl-sig-hi" title="${ta('ui.title.sigHi')}">★</span> `;
  if (a.significance < lo) return `<span class="cl-sig cl-sig-lo" title="${ta('ui.title.sigLo')}">·</span> `;
  return `<span class="cl-sig" title="${ta('ui.title.sigMid')}">•</span> `;
}

/** Иконка типа флага: галлюцинация / аудит / обычное противоречие. */
function driftIcon(f) {
  if (f.kind === 'hallucination') return '👻';
  return f.source === 'audit' ? '🔍' : '⚠️';
}

/**
 * Секция дрейфа/аномалий (Фаза C) + кнопка «Аудит сейчас» (Фаза D — кросс-арочный
 * аудит). Видна, если есть флаги ИЛИ периодический аудит включён.
 */
function renderDriftSection() {
  const s = getSettings();
  const flags = getDriftFlags();
  if (!flags.length && !s.drift?.auditEnabled) return '';
  const open = flags.filter((f) => !f.resolved).length;
  const controls = `<div class="cl-arc-controls">
      <button id="cl-drift-audit-now" title="${ta('ui.title.auditNowBtn')}">${t('ui.btn.auditNow')}</button>
    </div><div id="cl-drift-audit-out"></div>`;
  const rows = flags.length ? flags.map((f) => `
    <div class="cl-drift ${f.resolved ? 'cl-disabled' : ''}" data-id="${f.id}">
      <span class="cl-drift-kind" title="${escapeHtml(f.source === 'audit' ? t('ui.title.crossAudit') : f.kind)}">${driftIcon(f)}</span>
      <div class="cl-drift-text">
        <div>${escapeHtml(driftLine(f))}</div>
        ${f.detail ? `<div class="cl-drift-detail">${escapeHtml(f.detail)}</div>` : ''}
        <span class="cl-weight">${t('ui.label.arc', { id: f.arcId ?? '?' })}</span>
      </div>
      ${f.resolved ? '' : `<button data-drift-dismiss="${f.id}" class="cl-rm" title="${ta('ui.title.dismiss')}">✕</button>`}
    </div>`).join('') : `<p class="cl-empty">${t('ui.drift.empty')}</p>`;
  return section(t('ui.sec.drift'), flags.length ? t('ui.drift.open', { n: open }) : t('ui.drift.auditTag'), controls + rows, false);
}

function driftLine(f) {
  if (f.kind === 'hallucination') return t('ui.drift.hallucination', { from: f.from, rel: f.rel, to: f.to });
  return t('ui.drift.contradiction', { from: f.from, rel: f.rel, to: f.to });
}

// --- Таймлайн (Фаза D): что расширение сделало в фоне + точки восстановления ---
const ACTIVITY_ICON = {
  'arc-seal': '📦', extract: '🧪', 'graph-merge': '🕸', drift: '⚠️', audit: '🔍',
  branch: '🌿', restore: '⏪', 'global-copy': '🌐', 'global-disable': '🌐',
};
// Иконка точки восстановления по причине снапшота (бэкап).
const SNAPSHOT_ICON = {
  'arc-seal': '📸', rolling: '📸', safety: '🛟', manual: '💾', 'pre-restore': '⏪',
};

/** Компактное «N назад» для строки лога; полная метка — в title. */
function fmtAgo(at) {
  const ms = Date.now() - (Number(at) || 0);
  if (ms < 0 || !at) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Абсолютная метка времени для title (полная дата). */
function fmtFull(at) {
  try { return new Date(at).toLocaleString(); } catch { return ''; }
}

/** Строка события активности (то же, что было в Activity). */
function activityRow(e) {
  return `<div class="cl-drift" data-id="${e.id}">
    <span class="cl-drift-kind" title="${escapeHtml(e.kind)}">${ACTIVITY_ICON[e.kind] || '•'}</span>
    <div class="cl-drift-text">
      <div>${escapeHtml(e.detail || e.kind)}</div>
      <span class="cl-weight">${e.arcId != null ? `arc ${e.arcId} · ` : ''}<span title="${escapeHtml(fmtFull(e.at))}">${fmtAgo(e.at)}</span></span>
    </div>
  </div>`;
}

/** Строка точки восстановления (снапшот книги) + кнопка ⏪ Restore. */
function snapshotRow(e) {
  return `<div class="cl-drift" data-id="${e.id}">
    <span class="cl-drift-kind" title="${ta('ui.title.restorePoint')} · ${escapeHtml(e.reason)}">${SNAPSHOT_ICON[e.reason] || '📸'}</span>
    <div class="cl-drift-text">
      <div>${t('ui.timeline.restorePoint')} <span class="cl-weight">${escapeHtml(e.reason)}</span></div>
      <span class="cl-weight"><span title="${escapeHtml(fmtFull(e.at))}">${fmtAgo(e.at)}</span></span>
    </div>
    <button data-tl-restore="${e.id}" class="cl-rm" title="${ta('ui.title.restoreBtn')}">⏪</button>
  </div>`;
}

/**
 * Секция «Timeline» — единая хронология фоновых действий + точек восстановления
 * (Фаза D). Видна, если включён лог активности ИЛИ бэкапы (чтобы точки отката были
 * доступны даже при выключенном логе). Прячется целиком, если timeline.enabled=false.
 */
function renderTimelineSection() {
  const s = getSettings();
  if (s.timeline?.enabled === false) return '';
  const showActivity = !!s.activityLog?.enabled;
  const showSnapshots = s.backup?.enabled !== false;
  if (!showActivity && !showSnapshots) return '';

  const rows = buildTimeline();
  const controls = `<div class="cl-arc-controls">
      <button id="cl-tl-snapshot" title="${ta('ui.title.snapshotNowBtn')}">${t('ui.btn.snapshotNow')}</button>
      ${showActivity ? `<button id="cl-activity-clear" title="${ta('ui.title.clearLogBtn')}">${t('ui.btn.clearLog')}</button>` : ''}
    </div>`;
  let inner;
  if (!rows.length) {
    inner = controls + `<p class="cl-empty">${t('ui.timeline.empty')}</p>`;
  } else {
    // переиспользуем стили .cl-drift (как renderReviewCandidates) — без нового CSS.
    inner = controls + rows.map((e) => (e.type === 'snapshot' ? snapshotRow(e) : activityRow(e))).join('');
  }
  return section(t('ui.sec.timeline'), `${rows.length}`, inner, false);
}

// --- Бюджет контекста (Фаза D): индикатор здоровья памяти + condense/review ---
function budgetPct(rep) {
  if (!rep?.target) return 0;
  return Math.min(100, Math.round((rep.used / rep.target) * 100));
}
function fmtTok(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

/** Секция «Memory budget» (Фаза D). Скрыта, если бюджет выключен. */
function renderBudgetSection() {
  const s = getSettings();
  if (!s.contextBudget?.enabled) return '';
  const rep = getLastReport();
  if (!rep) {
    return section(t('ui.sec.budget'), t('ui.budget.idle'),
      `<p class="cl-empty">${t('ui.budget.empty')}</p>`, false);
  }
  const pct = budgetPct(rep);
  const over = rep.used > rep.target;
  const bar = `<div class="cl-budget-bar"><div class="cl-budget-fill ${over ? 'cl-budget-over' : ''}" style="width:${pct}%"></div></div>`;
  const head = `<div class="cl-budget">${bar}
    <div class="cl-budget-num">${fmtTok(rep.used)} / ${fmtTok(rep.target)}${over ? ' ⚠' : ''}</div></div>`;
  const tiers = Object.entries(rep.perTier || {}).sort((a, b) => b[1] - a[1])
    .map(([tier, n]) => `<div class="cl-budget-row"><span>${escapeHtml(tier)}</span><span class="cl-weight">${fmtTok(n)}</span></div>`).join('');
  const dl = [...new Set(rep.dropped || [])];
  const dropped = dl.length
    ? `<div class="cl-budget-row cl-budget-over"><span>${t('ui.budget.dropped')}</span><span class="cl-weight">${escapeHtml(dl.join(', '))}</span></div>` : '';
  const controls = `<div class="cl-arc-controls">
      <button id="cl-budget-tighten" title="${ta('ui.title.tightenBtn')}">${t('ui.btn.tighten')}</button>
      <button id="cl-budget-review" title="${ta('ui.title.reviewBtn')}">${t('ui.btn.review')}</button>
    </div>`;
  const inner = head + tiers + dropped + controls + '<div id="cl-budget-review-out"></div>';
  return section(t('ui.sec.budget'), `${pct}%`, inner, autoReview(rep));
}

function renderReviewCandidates(cands, summary) {
  if (!cands || !cands.length) {
    return `<p class="cl-empty">${escapeHtml(summary || t('ui.review.nothing'))}</p>`;
  }
  const rows = cands.map((c) => `
    <div class="cl-drift" data-id="${c.id}">
      <span class="cl-drift-kind" title="${escapeHtml(c.reason)}">🧹</span>
      <div class="cl-drift-text">
        <div>${escapeHtml(c.label)}</div>
        <div class="cl-drift-detail">${escapeHtml(c.reason)}</div>
      </div>
      <button data-review-forget="${c.id}" class="cl-rm" title="${ta('ui.title.forgetRecoverable')}">✕</button>
    </div>`).join('');
  return `<p class="cl-empty">${escapeHtml(summary)}</p>${rows}`;
}

/** Свёртываемая секция <details>. */
function section(title, sub, inner, open) {
  return `<details class="cl-section" ${open ? 'open' : ''}>
    <summary>${escapeHtml(title)} ${sub ? `<span class="cl-count">${escapeHtml(sub)}</span>` : ''}</summary>
    <div class="cl-section-body">${inner}</div>
  </details>`;
}

function renderBufferHtml() {
  const buf = getBuffer();
  if (!buf.length) return `<p class="cl-empty">${t('ui.buffer.empty')}</p>`;
  return buf.slice().sort((a, b) => b.weight - a.weight).map((i) =>
    `<div class="cl-bufitem"><span>(${escapeHtml(i.kind)}) ${escapeHtml(i.text)}</span>
       <span class="cl-weight">w:${i.weight}</span>
       <button data-rm="${i.id}" class="cl-rm">✕</button></div>`).join('');
}

// --- Вкладка Saved (избранное + цитаты, фильтр-чипы) ---
function renderSavedHtml() {
  const chip = (v, label) => `<button class="cl-chip ${savedFilter === v ? 'cl-chip-on' : ''}" data-chip="${v}">${label}</button>`;
  const chips = `<div class="cl-chips">${chip('all', t('ui.chip.all'))}${chip('message', t('ui.chip.messages'))}${chip('quote', t('ui.chip.quotes'))}</div>`;

  let favs = getFavorites();
  if (savedFilter === 'quote') favs = favs.filter((f) => f.kind === 'quote');
  else if (savedFilter === 'message') favs = favs.filter((f) => f.kind !== 'quote');

  if (!favs.length) {
    return chips + `<p class="cl-empty">${t('ui.saved.empty')}</p>`;
  }
  const modeLabel = { permanent: t('ui.mode.permanent'), chance: t('ui.mode.chance'), relevant: t('ui.mode.relevant') };
  const modeOpt = (v, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${modeLabel[v] ?? v}</option>`;
  const kindIcon = (f) => (f.kind === 'quote'
    ? `<span class="cl-kind" title="${ta('ui.legend.quote')}">❝</span>`
    : `<span class="cl-kind" title="${ta('ui.legend.message')}">★</span>`);
  const rows = favs.map((f) => `
    <div class="cl-savedrow ${f.enabled ? '' : 'cl-disabled'}" data-id="${f.id}">
      <textarea class="cl-saved-text" data-edit="${f.id}">${escapeHtml(f.text)}</textarea>
      <div class="cl-saved-actions">
        ${kindIcon(f)}
        <select class="cl-mode" data-mode="${f.id}" title="${ta('ui.title.injectionMode')}">
          ${modeOpt('permanent', f.mode)}${modeOpt('chance', f.mode)}${modeOpt('relevant', f.mode)}
        </select>
        <button data-toggle="${f.id}" title="${f.enabled ? t('ui.title.disable') : t('ui.title.enable')}">${f.enabled ? '👁' : '🚫'}</button>
        <button data-pin="${f.id}" class="${f.pinned ? 'cl-on' : ''}" title="${ta('ui.title.pin')}">📌</button>
        <button data-promote="${f.id}" title="${ta('ui.title.promote')}">📚</button>
        <button data-rmfav="${f.id}" class="cl-rm" title="${ta('ui.title.delete')}">✕</button>
      </div>
    </div>`).join('');
  return chips + rows;
}

function wireBody(body, name) {
  if (name === 'memory') wireMemory(body);
  else if (name === 'thoughts') {
    body.querySelectorAll('[data-rm]').forEach((b) =>
      b.addEventListener('click', async () => { await removeBufItem(b.dataset.rm); await switchTab('thoughts'); }));
  } else {
    wireSaved(body);
  }
}

function wireMemory(body) {
  // Backfill-баннер: открыть попап с выбором Full/Light и перерисовать таб после.
  body.querySelector('#cl-backfill-banner-btn')?.addEventListener('click', async () => {
    try { await runBackfillFlow(); } catch (e) { console.warn('[ChaoticLorebooks] backfill flow:', e); }
    await switchTab('memory');
  });
  // добавить авторскую заметку (origin=user, никогда не перезаписывается автоматикой)
  body.querySelector('#cl-note-add')?.addEventListener('click', async () => {
    const input = body.querySelector('#cl-note-input');
    const text = input?.value?.trim();
    if (!text) return;
    try {
      // Явное действие юзера → можно показать попап выбора книги (если askOnFirstUse).
      await ensureBook(getSettings());
      const { enqueueWrite } = await import('../lorebook/lorebook-writer.js');
      const ok = await enqueueWrite({
        origin: 'author-note', tier: 'foundation',
        content: text, treePath: 'Author notes',
        title: text.split(/\s+/).slice(0, 5).join(' '),
      });
      globalThis.toastr?.[ok ? 'success' : 'info']?.(ok ? t('toast.noteSaved') : t('toast.noteNoBook'));
    } catch (e) {
      console.warn('[ChaoticLorebooks] author-note write failed:', e);
      globalThis.toastr?.warning?.(t('toast.noteFail'));
    }
    input.value = '';
    await switchTab('memory');
  });

  // воспоминания: тумблер active / удаление
  body.querySelectorAll('[data-rec-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      const g = getGists().find((x) => x.id === b.dataset.recToggle);
      await setRecActive(b.dataset.recToggle, g?.active === false); await switchTab('memory');
    }));
  body.querySelectorAll('[data-rec-rm]').forEach((b) =>
    b.addEventListener('click', async () => { await removeGist(b.dataset.recRm); await switchTab('memory'); }));

  // арки: запечатать сейчас / вернуть скрытое / забыть арку
  body.querySelector('#cl-arc-seal')?.addEventListener('click', async () => {
    const sealed = await sealReady();
    if (sealed) { await afterSeal(sealed); globalThis.toastr?.success?.(t('toast.arcSealed', { id: sealed.id })); }
    else globalThis.toastr?.info?.(t('toast.nothingToSeal'));
    await switchTab('memory');
  });
  body.querySelector('#cl-arc-reveal')?.addEventListener('click', async () => {
    await autoHideRevealAll(); globalThis.toastr?.success?.(t('toast.hiddenRevealed'));
    await switchTab('memory');
  });
  body.querySelectorAll('[data-arc-forget]').forEach((b) =>
    b.addEventListener('click', async () => {
      await bulkSetArc(Number(b.dataset.arcForget), false);
      globalThis.toastr?.info?.(t('toast.arcMuted', { id: b.dataset.arcForget }));
      await switchTab('memory');
    }));

  // дрейф: снять флаг (Dismiss) — помечаем resolved, ничего не удаляем из графа
  body.querySelectorAll('[data-drift-dismiss]').forEach((b) =>
    b.addEventListener('click', async () => {
      await resolveDriftFlag(b.dataset.driftDismiss);
      await switchTab('memory');
    }));

  // таймлайн: «Clear log» — очистить ленту активности (память/снапшоты не трогаем).
  body.querySelector('#cl-activity-clear')?.addEventListener('click', async () => {
    await clearActivityLog();
    await switchTab('memory');
  });

  // таймлайн: «Snapshot now» — ручная точка восстановления.
  body.querySelector('#cl-tl-snapshot')?.addEventListener('click', async () => {
    const id = await snapshotNow();
    globalThis.toastr?.[id ? 'success' : 'info']?.(id ? t('toast.snapshotSaved') : t('toast.snapshotNoBook'));
    await switchTab('memory');
  });

  // таймлайн: «⏪ Restore» — откат книги к точке. Подтверждение + safety-снапшот внутри.
  body.querySelectorAll('[data-tl-restore]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.tlRestore;
      const c = SillyTavern.getContext();
      const wrap = document.createElement('div');
      wrap.className = 'cl-confirm';
      wrap.innerHTML = `<p>${t('popup.restore.body1')}</p><p class="cl-hint">${t('popup.restore.body2')}</p>`;
      let res;
      try {
        res = await c.callGenericPopup(wrap, c.POPUP_TYPE?.CONFIRM ?? 2, '', { okButton: t('popup.restore'), cancelButton: t('popup.cancel') });
      } catch { res = false; }
      const affirmative = c.POPUP_RESULT?.AFFIRMATIVE ?? 1;
      if (res !== affirmative && res !== true) return;
      const ok = await restoreTo(id);
      globalThis.toastr?.[ok ? 'success' : 'warning']?.(ok ? t('toast.restoreOk') : t('toast.restoreFail'));
      await switchTab('memory');
    }));

  // дрейф: «Аудит сейчас» — кросс-арочный аудит графа. В autonomous → один LLM-проход;
  // иначе код-only (структурные противоречия + suspect), без платного вызова.
  body.querySelector('#cl-drift-audit-now')?.addEventListener('click', async () => {
    const btn = body.querySelector('#cl-drift-audit-now');
    const out = body.querySelector('#cl-drift-audit-out');
    if (btn) btn.disabled = true;
    if (out) out.innerHTML = `<p class="cl-empty">${t('ui.auditing')}</p>`;
    const paidAllowed = !!getSettings().autonomous?.enabled;
    const { added, summary } = await runAudit({ paidAllowed });
    const note = added ? t('toast.auditNew', { n: added, summary }) : t('toast.auditNone', { summary });
    globalThis.toastr?.[added ? 'warning' : 'success']?.(note);
    await switchTab('memory');
  });

  // бюджет: «Сократить» — опускаем target на шаг (эффект со след. генерации)
  body.querySelector('#cl-budget-tighten')?.addEventListener('click', async () => {
    const s = getSettings();
    const cur = s.contextBudget?.target ?? 3000;
    s.contextBudget.target = Math.max(500, cur - 500);
    saveSettings();
    globalThis.toastr?.info?.(t('toast.budgetTarget', { n: s.contextBudget.target }));
    await switchTab('memory');
  });
  // бюджет: «Пересмотр» — список устаревших огрызков; «забыть» = active=false (восстановимо)
  body.querySelector('#cl-budget-review')?.addEventListener('click', async () => {
    const out = body.querySelector('#cl-budget-review-out');
    if (out) out.innerHTML = `<p class="cl-empty">${t('ui.reviewing')}</p>`;
    const { candidates, summary } = await review();
    if (out) out.innerHTML = renderReviewCandidates(candidates, summary);
    body.querySelectorAll('[data-review-forget]').forEach((b) =>
      b.addEventListener('click', async () => {
        await setRecActive(b.dataset.reviewForget, false);
        globalThis.toastr?.info?.(t('toast.recForgotten'));
        await switchTab('memory');
      }));
  });
}

function wireSaved(body) {
  body.querySelectorAll('[data-chip]').forEach((b) =>
    b.addEventListener('click', () => { savedFilter = b.dataset.chip; switchTab('saved'); }));
  // Высота поля = высоте контента, и растёт при наборе → re-render не «сбрасывает
  // растянутое поле к исходному размеру» (длинные соо больше не урезаются на 500).
  const autoSize = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  body.querySelectorAll('[data-edit]').forEach((ta) => {
    autoSize(ta);
    ta.addEventListener('input', () => autoSize(ta));
    ta.addEventListener('change', () => editText(ta.dataset.edit, ta.value));
  });
  body.querySelectorAll('[data-mode]').forEach((sel) =>
    sel.addEventListener('change', () => setMode(sel.dataset.mode, sel.value)));
  body.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      const f = getFavorites().find((x) => x.id === b.dataset.toggle);
      await setEnabled(b.dataset.toggle, !(f?.enabled)); await switchTab('saved');
    }));
  body.querySelectorAll('[data-pin]').forEach((b) =>
    b.addEventListener('click', async () => {
      const f = getFavorites().find((x) => x.id === b.dataset.pin);
      await setPinned(b.dataset.pin, !(f?.pinned)); await switchTab('saved');
    }));
  body.querySelectorAll('[data-promote]').forEach((b) =>
    b.addEventListener('click', async () => { await saveAsEntry(b.dataset.promote); await switchTab('saved'); }));
  body.querySelectorAll('[data-rmfav]').forEach((b) =>
    b.addEventListener('click', async () => { await removeFavorite(b.dataset.rmfav); await switchTab('saved'); }));
}

function escapeHtml(s) {
  // DOMPurify живёт на ctx.libs (или window-шиме), не на SillyTavern.libs.
  const DOMPurify = SillyTavern.getContext()?.libs?.DOMPurify ?? globalThis.DOMPurify;
  const str = String(s ?? '');
  return DOMPurify ? DOMPurify.sanitize(str) : str.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// t() для значения HTML-атрибута (title="…"/placeholder="…"). ВСЕГДА экранируем
// кавычки/угловые сами: escapeHtml идёт через DOMPurify.sanitize, а тот НЕ
// экранирует " в текстовом контексте → для атрибута его недостаточно.
function ta(key, vars) {
  return String(t(key, vars)).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
