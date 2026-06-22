// backup.js — снапшоты привязанной книги (SPEC §3b, Фаза A).
// Гибрид: rolling (последние K снапшотов) + safety-снапшот ПЕРЕД каждой опасной
// авто-операцией (перезапись энтри, будущие консолидация/мёрж/переписывание dirty-арки).
// Восстановление возвращает книгу к выбранному снапшоту.
//
// Хранилище: chatMetadata['chaoticLorebooks_backups'] — массив {id,at,reason,book,data}.
// Ограничено backup.keepCount, чтобы метаданные не раздувались. Всё 🟢.

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
    data: structuredClone(data),     // полная копия (книги чата невелики)
  };
  const arr = store();
  arr.push(snap);
  // rolling: держим только последние keepCount.
  const keep = Math.max(1, s.keepCount ?? 8);
  if (arr.length > keep) arr.splice(0, arr.length - keep);
  await persist();
  return snap.id;
}

/** Обычный rolling-снапшот (например по таймеру/событию). */
export function snapshot(reason = 'rolling') { return makeSnapshot(reason); }

/** Safety-снапшот ПЕРЕД опасной авто-операцией. Уважает backup.safetyBeforeOps. */
export function safetySnapshot(reason = 'safety') {
  const s = getSettings().backup ?? {};
  if (s.safetyBeforeOps === false) return Promise.resolve(null);
  return makeSnapshot(reason);
}

/** Список снапшотов (для UI/таймлайна). */
export function listSnapshots() {
  return store().map(({ id, at, reason, book }) => ({ id, at, reason, book }));
}

/** Восстановить книгу из снапшота. Возвращает true при успехе. */
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
