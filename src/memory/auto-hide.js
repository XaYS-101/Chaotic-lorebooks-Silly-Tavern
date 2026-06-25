// auto-hide.js — keeps the active window small by hiding old messages per sealed arc
// (SPEC §4b, §9b). Uses is_system flag (NOT deletion), fully reversible.
// Guarantees: only hide after capture (i ≤ watermark + sealed arc); slice by whole
// arcs; keep tail bridge visible; never touch the live window or pinned favorites.
// Tracked in chatMetadata → revealAll restores exactly what we hid. 🟢 pure code.

import { getSettings, backgroundJobsAllowed } from '../core/settings.js';
import { getSealedArcs } from './arc-segmenter.js';
import { getFavorites } from '../inject/favorites.js';

const HIDDEN_KEY = 'chaoticLorebooks_hidden';
const WM_KEY = 'chaoticLorebooks_watermark';

function ctx() { return SillyTavern.getContext(); }
function chat() { return ctx().chat ?? []; }
function watermark() { return ctx().chatMetadata?.[WM_KEY] ?? -1; }

function hiddenSet() {
  const meta = ctx().chatMetadata;
  if (!meta) return new Set();
  if (!Array.isArray(meta[HIDDEN_KEY])) meta[HIDDEN_KEY] = [];
  return new Set(meta[HIDDEN_KEY]);
}
function saveHidden(set) {
  const meta = ctx().chatMetadata;
  if (meta) meta[HIDDEN_KEY] = [...set].sort((a, b) => a - b);
}
async function persistMeta() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }
async function persistChat() { try { await ctx().saveChat?.(); } catch { /* no-op */ } }

function pinnedIndices() {
  const set = new Set();
  for (const f of getFavorites()) if (f.pinned && typeof f.mesIndex === 'number') set.add(f.mesIndex);
  return set;
}

/** Is this an ST-native system/comment/author-note message? Single predicate so auto-hide and favorites (index.js) agree. */
export const isStSystemMessage = (m) => !!m?.is_system;

/** Is this message ST-owned (not ours)? Our own hidden messages are also is_system=true but tracked — distinguish by set. ST-owned messages must never be touched. */
function isForeignSystem(i, tracked) {
  if (tracked.has(i)) return false;        // we hid it — ours
  return isStSystemMessage(chat()[i]);     // is_system not ours → ST-owned
}

/** Low-level: mark a message hidden/visible (mirrors hideChatMessageRange). */
function setHidden(i, hide) {
  const m = chat()[i];
  if (!m) return false;
  m.is_system = hide;
  const block = document.querySelector(`#chat .mes[mesid="${i}"]`);
  if (block) block.setAttribute('is_system', String(hide));
  return true;
}

/** Maintain the active window: compute target hidden set and apply the diff. Called from injector before assembly and after arc sealing. */
export async function maintain() {
  const s = getSettings().autoHide ?? {};
  const tracked = hiddenSet();

  if (s.enabled === false) {
    if (tracked.size) await revealAll();     // disabled → restore everything we hid
    return;
  }

  const len = chat().length;
  const window = Math.max(2, s.windowSize ?? 12);
  const keepTail = Math.max(0, s.keepTailFromSlab ?? 2);
  // Require summaryGist only when summaries can appear (not lite). In lite no bg jobs run → no summary ever; preserve old lite behavior (hide sealed slab immediately).
  const afterSummary = s.afterSummary !== false && backgroundJobsAllowed();
  const scope = s.scope === 'newest' ? 'newest' : 'slab';
  const wm = watermark();
  const visibleFloor = len - window;         // indices ≥ floor — live window (ALWAYS visible)

  const pinned = pinnedIndices();

  // Candidate arcs: sealed, entirely behind the live window (end < floor — slice by slab, don't split arcs), captured (end ≤ watermark), and — if afterSummary — already summarized.
  let arcs = getSealedArcs()
    .filter((a) => a.end != null && a.end < visibleFloor && a.end <= wm)
    .filter((a) => !afterSummary || (a.summaryGist && String(a.summaryGist).trim()))
    .sort((a, b) => a.start - b.start);
  if (!arcs.length) { if (tracked.size) await revealAll(); return; }

  const newestEnd = Math.max(...arcs.map((a) => a.end));
  // scope 'newest' → hide only the newest summarized slab; 'slab' → all candidates.
  if (scope === 'newest') arcs = arcs.filter((a) => a.end === newestEnd);

  // Target hidden set: all within candidate arcs, but NOT in the live window.
  const target = new Set();
  for (const a of arcs) {
    // Keep the last keepTail messages of EVERY hidden arc visible — bridges between
    // arcs (gradual reveal). If keepTail covers the whole arc, nothing is hidden.
    const hideEnd = Math.max(a.start - 1, a.end - keepTail);
    for (let i = a.start; i <= hideEnd; i++) {
      if (i >= visibleFloor) continue;       // in live window — don't touch
      if (pinned.has(i)) continue;           // pinned — immune
      if (isForeignSystem(i, tracked)) continue; // author note / ST system — don't touch
      target.add(i);
    }
  }

  // Diff: hide new, show those that fell out of target (e.g. arc became dirty or window shifted back).
  let changed = false;
  for (const i of target) if (!tracked.has(i)) { if (setHidden(i, true)) { tracked.add(i); changed = true; } }
  for (const i of [...tracked]) {
    if (!target.has(i)) { setHidden(i, false); tracked.delete(i); changed = true; }
  }

  if (changed) { saveHidden(tracked); await persistMeta(); await persistChat(); }
}

/** Hide a specific arc as a slab (manual trigger). */
export async function hideArcSlab(arcId) {
  const arc = getSealedArcs().find((a) => a.id === arcId);
  if (!arc || arc.end == null) return;
  const tracked = hiddenSet();
  const pinned = pinnedIndices();
  let changed = false;
  for (let i = arc.start; i <= arc.end; i++) {
    if (pinned.has(i)) continue;
    if (isForeignSystem(i, tracked)) continue;   // author note / ST system — don't touch
    if (setHidden(i, true)) { tracked.add(i); changed = true; }
  }
  if (changed) { saveHidden(tracked); await persistMeta(); await persistChat(); }
}

/** Reveal everything WE hid (never touches manual user /hide). */
export async function revealAll() {
  const tracked = hiddenSet();
  if (!tracked.size) return;
  for (const i of tracked) setHidden(i, false);
  saveHidden(new Set());
  await persistMeta();
  await persistChat();
}
