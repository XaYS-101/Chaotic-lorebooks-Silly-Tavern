// timeline.js — merges activity log + lorebook snapshots into a single chronology
// plus safe rollback (Phase D, slice 5). 🟢 pure code.
// buildTimeline() → unified feed (newest first); restoreTo(id) → safe, reversible
// rollback with a pre-restore safety snapshot. No LLM, no injection impact. Only
// imported by tree-ui (one-way dependency).

import { getSettings } from '../core/settings.js';
import { getLog, log as logActivity } from './activity-log.js';
import {
  listSnapshots, restore as restoreSnapshot, safetySnapshot, snapshot,
} from '../lorebook/backup.js';

/** Unified timeline: activity events + restore points (snapshots). Newest first. Each type respects its toggle. */
export function buildTimeline() {
  const s = getSettings();
  const out = [];

  if (s.activityLog?.enabled) {
    for (const e of getLog()) {
      out.push({
        type: 'activity', at: Number(e.at) || 0, id: e.id,
        kind: e.kind, detail: e.detail, arcId: e.arcId ?? null,
      });
    }
  }
  if (s.backup?.enabled !== false) {
    for (const snap of listSnapshots()) {
      out.push({
        type: 'snapshot', at: Number(snap.at) || 0, id: snap.id,
        reason: snap.reason || 'rolling', book: snap.book,
      });
    }
  }

  out.sort((a, b) => b.at - a.at);   // newest first
  return out;
}

/** Roll back the lorebook to a chosen snapshot. Safe and reversible: pre-restore safety snapshot → restore → reset memory cache → log activity. Fully guarded by try/catch. */
export async function restoreTo(id) {
  try {
    const snap = listSnapshots().find((x) => x.id === id);
    await safetySnapshot('pre-restore');       // undo can be undone
    const ok = await restoreSnapshot(id);
    if (!ok) return false;

    // Memory core cache is stale — next scene rebuilds from the rolled-back book.
    // Dynamic import: don't pull a static edge into the dependency graph.
    try { const { resetCache } = await import('./memory-engine.js'); resetCache(); } catch { /* no-op */ }

    const reason = snap?.reason || 'snapshot';
    const when = (() => { try { return new Date(snap?.at).toLocaleString(); } catch { return ''; } })();
    logActivity({ kind: 'restore', detail: `from ${reason}${when ? ` · ${when}` : ''}` }).catch(() => {});
    return true;
  } catch (e) {
    console.warn('[ChaoticLorebooks] restoreTo failed:', e);
    return false;
  }
}

/** Take a manual restore point ("Snapshot now" button). */
export function snapshotNow() { return snapshot('manual'); }
