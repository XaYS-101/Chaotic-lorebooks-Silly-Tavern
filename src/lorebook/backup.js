// backup.js — snapshots of the bound book (SPEC §3b, Phase A).
// Hybrid: rolling (last K snapshots) + a safety snapshot BEFORE each risky auto
// operation (entry overwrite, future consolidate/merge/dirty-arc rewrite).
// Restore returns the book to a chosen snapshot.
//
// Storage: chatMetadata['chaoticLorebooks_backups'] — array of {id,at,reason,book,data}.
// Capped by backup.keepCount so metadata doesn't bloat. All 🟢.

import { getSettings } from '../core/settings.js';
import { getBoundBookName } from './lorebook-service.js';

const BACKUP_KEY = 'chaoticLorebooks_backups';

function ctx() { return SillyTavern.getContext(); }
function store() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[BACKUP_KEY])) meta[BACKUP_KEY] = [];
  return meta[BACKUP_KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

async function makeSnapshot(reason) {
  const s = getSettings().backup ?? {};
  if (s.enabled === false) return null;
  const book = getBoundBookName();
  if (!book) return null;
  let data;
  try { data = await ctx().loadWorldInfo(book); } catch { data = null; }
  if (!data) return null;

  const snap = {
    id: `bk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(), reason: reason || 'manual', book,
    data: structuredClone(data),     // full copy (chat books are small)
  };
  const arr = store();
  arr.push(snap);
  // rolling: keep only the last keepCount.
  const keep = Math.max(1, s.keepCount ?? 8);
  if (arr.length > keep) arr.splice(0, arr.length - keep);
  await persist();
  return snap.id;
}

/** Regular rolling snapshot (e.g. on timer/event). */
export function snapshot(reason = 'rolling') { return makeSnapshot(reason); }

/** Safety snapshot BEFORE a risky auto operation. Respects backup.safetyBeforeOps. */
export function safetySnapshot(reason = 'safety') {
  const s = getSettings().backup ?? {};
  if (s.safetyBeforeOps === false) return Promise.resolve(null);
  return makeSnapshot(reason);
}

/** List snapshots (for UI/timeline). */
export function listSnapshots() {
  return store().map(({ id, at, reason, book }) => ({ id, at, reason, book }));
}

/** Restore a book from a snapshot. Returns true on success. */
export async function restore(id) {
  const snap = store().find((x) => x.id === id);
  if (!snap) return false;
  try {
    await ctx().saveWorldInfo(snap.book, structuredClone(snap.data), true);
    await ctx().updateWorldInfoList?.();
    return true;
  } catch (e) {
    console.warn('[ChaoticLorebooks] restore failed:', e);
    return false;
  }
}
