// activity-log.js — видимая лента фоновых действий расширения (Фаза D). Всё 🟢.
//
// В autonomous фоновый воркер молча запечатывает арки, извлекает саммари, мёржит
// граф, флагует дрейф и гоняет аудит — пользователь не видит, ЧТО расширение
// сделало, пока он не смотрел. Эта лента — чистая локальная бухгалтерия: на каждое
// заметное фоновое событие пишем одну строку (kind + детали + арка + время).
//
// Железные правила: НЕ LLM, НЕ пишем в книгу, НЕ трогаем инъекцию (injector/
// memory-engine нас не импортируют) → поведение памяти в любом режиме байт-в-байт
// как без лога. Лист-модуль (импортит только settings) — вызыватели импортят НАС,
// цикла нет. Хранение per-chat в chatMetadata (как drift), с потолком; persist
// best-effort. Выключено → log() это no-op. «Очистить» трёт ТОЛЬКО лог, не память.
//
// Зеркалит store/persist/cap из deep-extractor (тот же проверенный паттерн).

import { getSettings } from './settings.js';

const ACTIVITY_KEY = 'chaoticLorebooks_activity';
const ACTIVITY_CAP = 100;   // жёсткий backstop; пользовательский лимит — activityLog.maxEntries

function ctx() { return SillyTavern.getContext(); }

/** Лента из chatMetadata (своя на чат). Лениво инициализирует массив. */
function store() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[ACTIVITY_KEY])) meta[ACTIVITY_KEY] = [];
  return meta[ACTIVITY_KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

/**
 * Записать одно фоновое действие в ленту. No-op, если лог выключен. Полностью
 * защищено — никогда не бросает в критический путь вызывателя (fire-and-forget).
 * @param {{kind:string, detail?:string, arcId?:number|null}} ev
 * @returns {Promise<void>}
 */
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
    if (arr.length > cap) arr.splice(0, arr.length - cap);   // выкинуть старейшие
    await persist();
  } catch { /* лог не должен мешать фоновой работе */ }
}

/** Вся лента для UI — новые сверху (копия, не живой массив). */
export function getLog() {
  return store().slice().reverse();
}

/** Очистить ленту (кнопка «Clear» в UI). Трёт только лог, не память. */
export async function clearLog() {
  const arr = store();
  arr.length = 0;
  await persist();
  return true;
}
