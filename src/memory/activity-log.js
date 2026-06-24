// activity-log.js — visible feed of background actions (Phase D). 🟢 pure code.
// Per-chat in chatMetadata, capped, fire-and-forget. Disabled → log() is a no-op.
// Never touches injection, lorebook, or LLM → zero impact on memory behavior.

import { getSettings } from '../core/settings.js';

const ACTIVITY_KEY = 'chaoticLorebooks_activity';
const ACTIVITY_CAP = 100;   // hard backstop; user limit → activityLog.maxEntries

function ctx() { return SillyTavern.getContext(); }

/** Get log array from chatMetadata, lazily init. */
function store() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[ACTIVITY_KEY])) meta[ACTIVITY_KEY] = [];
  return meta[ACTIVITY_KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

/** Write one background action. No-op when disabled. Fire-and-forget. */
export async function log({ kind, detail = '', arcId = null } = {}) {
  try {
    const s = getSettings();
    if (!s.activityLog?.enabled || !kind) return;
    const arr = store();
    arr.push({
      id: `a_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
      kind: String(kind),
      detail: String(detail || ''),
      arcId: arcId ?? null,
      at: Date.now(),
    });
    const cap = Math.max(10, Math.min(ACTIVITY_CAP, s.activityLog?.maxEntries ?? ACTIVITY_CAP));
    if (arr.length > cap) arr.splice(0, arr.length - cap);   // drop oldest
    await persist();
  } catch { /* log must never disrupt background work */ }
}

/** Full feed for UI — newest first (copy, not live array). */
export function getLog() {
  return store().slice().reverse();
}

/** Clear the feed (UI "Clear" button). Deletes only the log, not memory. */
export async function clearLog() {
  const arr = store();
  arr.length = 0;
  await persist();
  return true;
}
