// timeline.js — слияние ленты активности и снапшотов книги в одну хронологию +
// безопасный откат (Фаза D, slice 5). Всё 🟢.
//
// backup.js давно тихо снимает снапшоты (rolling на запечатке арки, safety перед
// каждой опасной авто-записью), но restore() из UI недостижим. Этот модуль —
// тонкий слой: buildTimeline() сливает activity-log + снапшоты в один список
// (новые сверху), restoreTo(id) делает ОТКАТ безопасно и обратимо.
//
// Железные правила: НЕ LLM, НЕ трогаем инъекцию (injector/memory-engine нас не
// импортируют). Импортим только НИЖНИЕ модули (settings/activity-log/backup) →
// цикла нет; нас импортит только tree-ui (односторонне). Откат обратим: ПЕРЕД
// перезаписью снимаем safety-снапшот 'pre-restore', поэтому отмену можно отменить.
// Запись в книгу — только через backup.restore() (никаких прямых saveWorldInfo).

import { getSettings } from '../core/settings.js';
import { getLog, log as logActivity } from './activity-log.js';
import {
  listSnapshots, restore as restoreSnapshot, safetySnapshot, snapshot,
} from '../lorebook/backup.js';

/**
 * Единая хронология: события активности + точки восстановления (снапшоты).
 * Возвращает массив, отсортированный по времени УБЫВАЮЩЕ (новые сверху).
 * Каждый тип строк уважает свой тумблер: активность — activityLog.enabled,
 * снапшоты — backup.enabled.
 * @returns {Array<{type:'activity'|'snapshot', at:number, id:string, ...}>}
 */
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

  out.sort((a, b) => b.at - a.at);   // новые сверху
  return out;
}

/**
 * Откатить книгу к выбранной точке восстановления. Безопасно и обратимо:
 *   1) safety-снапшот 'pre-restore' текущего состояния (чтобы отмену можно отменить);
 *   2) restore(id) из backup (пишет в книгу через ST);
 *   3) при успехе — сброс кэша ядра памяти (§4b), чтобы след. генерация увидела
 *      откат, и одна строка 'restore' в ленту активности.
 * Полностью защищено try/catch — никогда не бросает в UI-обработчик.
 * @param {string} id — id снапшота
 * @returns {Promise<boolean>} true при успешном откате
 */
export async function restoreTo(id) {
  try {
    const snap = listSnapshots().find((x) => x.id === id);
    await safetySnapshot('pre-restore');       // обратимость отмены
    const ok = await restoreSnapshot(id);
    if (!ok) return false;

    // Кэш ядра памяти устарел — следующая сцена пересоберёт его из откатанной книги.
    // Динамический импорт: не тянем статическое ребро в граф зависимостей.
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

/** Снять точку восстановления вручную (кнопка «Snapshot now»). */
export function snapshotNow() { return snapshot('manual'); }
