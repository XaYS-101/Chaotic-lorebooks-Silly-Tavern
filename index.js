// index.js — thin orchestrator. Only init, event wiring, and entry-point
// registration. All logic lives in the modules.

import { getSettings, saveSettings, backgroundJobsAllowed, MODULE_NAME } from './src/core/settings.js';
import { injectContext } from './src/inject/injector.js';
import { isChatEnabled, toggleChatEnabled } from './src/core/chat-state.js';
import { decayTick } from './src/memory/thought-buffer.js';
import { toggleFavorite, isFav, addQuote, reconcileFavoritesAfterDelete } from './src/inject/favorites.js';
import { toggleDrawer, ensureDrawer } from './src/ui/tree-ui.js';
import { renderSettingsPanel } from './src/core/settings-panel.js';
import { reset as resetScene } from './src/memory/scene-detector.js';
import { resetCache as resetMemoryCache } from './src/memory/memory-engine.js';
import { log as logActivity } from './src/memory/activity-log.js';
// --- Phase A — foundation ---
import { onMessage as arcOnMessage, onEdit as arcOnEdit, reset as resetArc, sealReady, seedBaselineIfNeeded } from './src/memory/arc-segmenter.js';
import { maybeOfferBackfill, runBackfillFlow } from './src/memory/backfill.js';
import { maintain as autoHideMaintain, revealAll as autoHideRevealAll, isStSystemMessage } from './src/memory/auto-hide.js';
import { resumeAfterRestart, registerHandler, enqueue } from './src/core/job-queue.js';
import { noteUserEditing } from './src/lorebook/lorebook-writer.js';
import { snapshot as backupSnapshot } from './src/lorebook/backup.js';
// --- Phase B — extraction + graph + tiers ---
import { summarizeArc, noteSettledForEmptyGistRetry, retryEmptyGistArcs } from './src/memory/arc-summary.js';
import { addTriples, invalidateArc } from './src/memory/knowledge-graph.js';
// --- Phase C — deep extraction (allow-list + significance + drift) ---
import { extractArc } from './src/memory/deep-extractor.js';
// --- Phase D — expensive cross-arc drift audit ---
import { runAudit, noteSettledForAudit } from './src/memory/drift-monitor.js';
// --- branch-guard — memory isolation on chat fork ---
import { maybeHandleFork } from './src/lorebook/branch-guard.js';
// --- global-reconciler — isolation when our book is active globally ---
import { maybeHandleGlobal } from './src/lorebook/global-reconciler.js';
// --- i18n — EN/RU localization for UI/toasts/slash-commands ---
import { t } from './src/core/i18n.js';
// --- purge — on-open metadata self-cleanup after "clear all data" (backstop) ---
import { purgeCurrentChatIfArmed } from './src/core/purge.js';

// --- Global prompt interceptor (name matches manifest) ---
// Runs before the generation request: assemble and inject context here.
const clInterceptor = async function (chat, contextSize, abort, type) {
  try {
    const s = getSettings();
    if (!s.enabled || !isChatEnabled()) return;   // master toggle OR disabled for this chat
    // Book is no longer created here — lazily on first real write (see lorebook-writer).
    await injectContext(type);  // type: swipes → cache; quiet → skip; see injector
  } catch (e) {
    console.warn('[ChaoticLorebooks] interceptor error:', e);
  }
};
globalThis.chaoticLorebooks_interceptor = clInterceptor;

function init() {
  const ctx = SillyTavern.getContext();
  const { eventSource, event_types } = ctx;

  // The manifest binds the interceptor by this exact global name. If it's missing
  // (e.g. the extension folder was renamed and the manifest no longer matches),
  // injection silently stops — warn so it's diagnosable.
  if (globalThis.chaoticLorebooks_interceptor !== clInterceptor) {
    console.warn('[ChaoticLorebooks] interceptor name mismatch — context injection disabled. Keep the extension folder named "chaotic-lorebooks".');
  }

  getSettings();              // init defaults
  ensureDrawer();             // create (hidden) tree
  renderSettingsPanel();      // settings panel (Basic/Advanced + Mode)
  addWandButton();            // menu open button
  registerSlashCommands(ctx);
  registerJobHandlers();      // background job handlers (Phase A)
  injectFavoriteStars();      // stars on messages
  setupQuoteFab();            // floating "save quote" button on selection (touch)

  // Reset UI on chat change (buffer/favorites metadata are per-chat)
  eventSource.on(event_types.CHAT_CHANGED, async () => {
    purgeCurrentChatIfArmed().catch(warn); // if the purge backstop is armed, scrub this chat's keys
    resetScene(); resetArc(); resetMemoryCache(); injectFavoriteStars();
    resumeAfterRestart();     // resume the new chat's persisted queue
    maybeHandleFork().catch(warn); // chat branch shares a book with its parent? offer fork
    maybeHandleGlobal().catch(warn); // target book active globally? offer a copy
    // Late-enabled chat: seed a baseline (anti-mega-arc) and, if needed,
    // offer a one-time backfill (modal once per chat + drawer banner).
    try {
      const threshold = getSettings().backfill?.threshold ?? 10;
      await seedBaselineIfNeeded(threshold);
      await maybeOfferBackfill();
    } catch (e) { warn(e); }
  });
  // Add stars to freshly rendered messages
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => injectFavoriteStars());
  eventSource.on(event_types.USER_MESSAGE_RENDERED, () => injectFavoriteStars());

  // --- Phase A: arcs / auto-hide / queue ---
  // Settled turn (bot message): advance watermark, seal the arc when it matures.
  if (event_types.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => onSettledTurn().catch(warn));
  }
  // Edit of an old message → typo gate → may mark that arc dirty → rollback + re-extract.
  if (event_types.MESSAGE_EDITED) {
    eventSource.on(event_types.MESSAGE_EDITED, (idx) => onEditedTurn(idx).catch(warn));
  }
  // User edits World Info manually → defer auto-writes (CAS/defer).
  if (event_types.WORLDINFO_UPDATED) {
    eventSource.on(event_types.WORLDINFO_UPDATED, () => noteUserEditing());
  }
  // Message deletion → shift favorites' mesIndex, drop those bound to the deleted one;
  // the star stops glowing after re-render (otherwise the message looks still captured).
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

  resumeAfterRestart();       // on startup: pick up unfinished jobs
  console.log('[ChaoticLorebooks] initialized');
}

const warn = (e) => console.warn('[ChaoticLorebooks]', e);

/** One settled turn: advance the arc; on seal, hide the layer + snapshot + extract. */
async function onSettledTurn() {
  const s = getSettings();
  if (!s.enabled || !isChatEnabled()) return;
  const sealed = await arcOnMessage();
  if (sealed) await afterSeal(sealed);  // single source of seal side-effects (see afterSeal)
  // Phase D: every ~N settled turns, run the expensive cross-arc audit (autonomous only).
  if (s.autonomous?.enabled && s.drift?.auditEnabled !== false && noteSettledForAudit()) {
    enqueue('audit-expensive', {}).catch(warn);
  }
  // Auto-regenerate empty arc summaries: every 3 real messages (not swipes),
  // check sealed arcs with no gist and re-extract them.
  if (s.extraction?.enabled !== false && await noteSettledForEmptyGistRetry(3)) {
    retryEmptyGistArcs().catch(warn);
  }
}

/**
 * Single source of arc-seal side-effects — for both auto (onSettledTurn) and manual
 * paths (/cl-arc, "Seal now" button): cache reset + activity log + snapshot + cheap
 * summary job (everywhere except lite) + auto-hide. One path → timeline/memory/hiding
 * behave the same whether triggered automatically or by hand.
 */
export async function afterSeal(sealed) {
  if (!sealed) return;
  const s = getSettings();
  resetMemoryCache();                 // §4b: new arc → core cache stale, rebuild on next shift
  logActivity({ kind: 'arc-seal', arcId: sealed.id, detail: `#${sealed.start}–${sealed.end}` }).catch(warn);
  if (s.backup?.enabled) backupSnapshot('arc-seal').catch(warn);
  // Phase B: extraction (summary+graph) as a cheap background job in all modes except lite.
  if (backgroundJobsAllowed(s)) enqueue('arc-extract', { arcId: sealed.id }).catch(warn);
  await autoHideMaintain().catch(warn); // hide the matured layer (post-summary in the job handler)
}

/** Edit of an old message: typo gate in the arc segmenter; significant → rollback + re-extract. */
async function onEditedTurn(idx) {
  if (!isChatEnabled()) return;
  const arc = await arcOnEdit(idx);     // null if typo / edit within the live window
  if (!arc) return;
  const s = getSettings();
  if (!s.autonomous?.enabled) return;   // without a worker it's just marked dirty (handled later)
  // Roll back this arc's contribution to the graph, then re-extract from scratch.
  await enqueue('graph-invalidate', { arcId: arc.id }).catch(warn);
  await enqueue('arc-extract', { arcId: arc.id }).catch(warn);
}

/** Background job handlers (Phase B — extraction/graph, 🟡; off the critical path). */
function registerJobHandlers() {
  // Sealed arc → cheap summary + voiceQuotes + triples.
  // After summary, auto-hide: the arc now has a gist, so hiding the layer is safe.
  registerHandler('arc-extract', async (payload) => {
    const ok = await summarizeArc(payload.arcId, { force: !!payload.force });
    if (ok) await autoHideMaintain().catch(warn);
  });
  // Phase C: allow-list (anti-hallucination) + drift flag → cleaned graph-merge.
  registerHandler('deep-extract', async (payload) => { await extractArc(payload); });
  // Triples → hybrid merge into the graph (per-arc provenance).
  registerHandler('graph-merge', async (payload) => { await addTriples(payload); });
  // Roll back a dirty arc's contribution (cascade limited to single-source edges).
  registerHandler('graph-invalidate', async (payload) => { await invalidateArc(payload.arcId); });
  // Phase D: expensive cross-arc drift audit (queue drains only in autonomous → paid OK).
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

// --- Favorite stars on every message ---
function injectFavoriteStars() {
  document.querySelectorAll('#chat .mes').forEach((mesEl) => {
    if (mesEl.querySelector('.cl-star')) return;
    const idx = Number(mesEl.getAttribute('mesid'));
    if (Number.isNaN(idx)) return;
    // Don't star system/comment/author-note ST messages — the star breaks their layout
    // ("css disappears" bug). Single model predicate (like auto-hide) + cheap DOM
    // fallback on the .smallSysMes class for messages not yet reflected in the model.
    if (mesEl.classList.contains('smallSysMes') || isStSystemMessage(SillyTavern.getContext().chat?.[idx])) return;
    const star = document.createElement('div');
    star.className = 'cl-star' + (isFav(idx) ? ' cl-star-on' : '');
    star.textContent = '★';
    star.title = t('ui.starTitle');
    star.addEventListener('click', async () => {
      // If text is selected within the message, save a QUOTE (a part), additively.
      const sel = window.getSelection?.();
      const selText = sel && !sel.isCollapsed && mesEl.contains(sel.anchorNode)
        ? sel.toString().trim() : '';
      if (selText) {
        await addQuote(idx, selText);
        star.classList.add('cl-star-pulse');
        setTimeout(() => star.classList.remove('cl-star-pulse'), 400);
        globalThis.toastr?.success?.(t('toast.quoteSaved')); // toastr is an ST window global
      } else {
        const on = await toggleFavorite(idx);
        star.classList.toggle('cl-star-on', on);
      }
    });
    const buttons = mesEl.querySelector('.mes_buttons') || mesEl;
    buttons.prepend(star);
  });
}

// --- Floating "save quote" button on text selection (touch-reliable: tapping the
// button doesn't lose the selection, and the text is cached in advance) ---
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
    // Find .mes from commonAncestorContainer (more reliable than anchorNode.parentElement —
    // anchorNode may be an Element or text inside a markdown wrapper).
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const mesEl = el?.closest?.('#chat .mes');
    if (!text || !mesEl) { scheduleHide(); return; }
    const idx = Number(mesEl.getAttribute('mesid'));
    if (Number.isNaN(idx)) { scheduleHide(); return; }
    cached = { idx, text };
    const rect = range.getBoundingClientRect();
    // Appear below the selection: on mobile the native Copy/Share menu sits above it
    // and would cover the FAB, making it hard to tap.
    const top = Math.min(window.innerHeight - 48, Math.max(8, rect.bottom + 8));
    const left = Math.min(window.innerWidth - 130, Math.max(8, rect.left));
    fab.style.top = `${top}px`;
    fab.style.left = `${left}px`;
    fab.classList.remove('cl-hidden');
  };

  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 150); };

  document.addEventListener('selectionchange', () => { clearTimeout(hideTimer); hideTimer = setTimeout(update, 120); });
  // selectionchange is throttled in some browsers — catch up on cursor/finger release.
  document.addEventListener('mouseup', () => setTimeout(update, 0));
  document.addEventListener('touchend', () => setTimeout(update, 0), { passive: true });
  // Scroll hides ONLY if the selection is already cleared — otherwise we'd lose the FAB
  // on mobile when the page jitters during touch selection.
  document.addEventListener('scroll', () => {
    const s = window.getSelection?.();
    if (!s || s.isCollapsed) hide();
  }, true);

  // Save on pointerdown — on mobile a button tap often never reaches click
  // (touchstart preventDefault suppresses synthetic click in Chrome/Safari), and click
  // arrives after the finger/mouse has already cleared the selection.
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
  // Fallback for browsers without Pointer Events.
  fab.addEventListener('click', doSave);
}

// --- Slash commands ---
function registerSlashCommands(ctx) {
  // Per ST: SlashCommandParser/SlashCommand live on getContext(), not on globalThis.
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
  // Explicit arc boundary: seal the open arc right now + hide the layer.
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
  // Reveal all auto-hidden messages.
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-reveal`,
    callback: async () => { await autoHideRevealAll(); globalThis.toastr?.success?.(t('toast.hiddenRevealed')); return ''; },
    helpString: t('cmd.reveal'),
  }));
  // Enable/disable the extension for the CURRENT chat (injection + background memory).
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-chat`,
    callback: async () => {
      const on = await toggleChatEnabled();
      globalThis.toastr?.[on ? 'success' : 'info']?.(on ? t('toast.chatOn') : t('toast.chatOff'));
      return '';
    },
    helpString: t('cmd.chat'),
  }));
  // One-time backfill for a late-enabled chat (Full = cheap AI / Light = no AI).
  SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: `${p}-backfill`,
    callback: async () => { await runBackfillFlow(); return ''; },
    helpString: t('cmd.backfill'),
  }));
}

// Start once extensions are ready.
const ctx = SillyTavern.getContext();
if (ctx.eventSource && ctx.event_types?.APP_READY) {
  ctx.eventSource.on(ctx.event_types.APP_READY, init);
} else {
  // fallback: a short timeout if the event is unavailable
  setTimeout(init, 1500);
}

export { MODULE_NAME, getSettings, saveSettings };
