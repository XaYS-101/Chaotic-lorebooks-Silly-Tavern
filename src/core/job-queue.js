// job-queue.js — фоновый воркер с persisted-очередью (SPEC §2, Фаза A).
// Вся «дорогая»/фоновая работа (саммари арки, мёрж графа, дрейф-флаг) проходит
// ЗДЕСЬ, вне критического пути ответа. Интерсептор НИКОГДА не await'ит очередь.
//
// Гарантии:
//   - persisted в chatMetadata → перезапуск ST возобновляет pending-джобы;
//   - concurrency 1-2 (настройка autonomous.concurrency);
//   - budget cap по числу LLM-вызовов в час (autonomous.callsPerHour);
//   - деградация: упавший обработчик → джоба failed, чат не страдает.
//
// Метки: 🟢 каркас (обработчики могут быть 🟡).

import { getSettings, backgroundJobsAllowed } from './settings.js';

const QUEUE_KEY = 'chaoticLorebooks_queue';
const BACKFILL_KEY = 'chaoticLorebooks_backfillActive';

// Колбэки на полный дренаж очереди (используется backfill'ом: дождаться, пока
// все arc-extract'ы прошли, и запустить auto-hide + тост).
const drainedCallbacks = [];
export function onQueueDrained(fn) { if (typeof fn === 'function') drainedCallbacks.push(fn); }
function fireDrained() {
  for (const fn of drainedCallbacks.splice(0)) {
    try { Promise.resolve(fn()).catch((e) => console.warn('[ChaoticLorebooks] onDrained:', e)); }
    catch (e) { console.warn('[ChaoticLorebooks] onDrained:', e); }
  }
}

/** Включить/выключить «backfill активен»: на время прогон extraction разрешён вне Autonomous. */
export async function setBackfillActive(on) {
  const meta = ctx().chatMetadata;
  if (!meta) return;
  meta[BACKFILL_KEY] = !!on;
  await persist();
  if (on) start();
}
export function isBackfillActive() { return !!ctx().chatMetadata?.[BACKFILL_KEY]; }

function ctx() { return SillyTavern.getContext(); }
function nowTs() { return Date.now(); }

/** Очередь персистится в метаданные чата. */
function getQueue() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[QUEUE_KEY])) meta[QUEUE_KEY] = [];
  return meta[QUEUE_KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

// Реестр обработчиков: kind → async (payload) => any. Регистрируются модулями.
const handlers = new Map();
export function registerHandler(kind, fn) { handlers.set(kind, fn); }

// Кольцевой счётчик LLM-вызовов в час (budget cap). В памяти (на сессию).
let callTimestamps = [];
function underBudget() {
  const cap = getSettings().autonomous?.callsPerHour ?? 30;
  const hourAgo = nowTs() - 3600_000;
  callTimestamps = callTimestamps.filter((t) => t > hourAgo);
  return callTimestamps.length < cap;
}
/** Обработчик зовёт это перед платным LLM-вызовом (для учёта бюджета). */
export function noteLlmCall() { callTimestamps.push(nowTs()); }

let running = 0;
let draining = false;

/** Добавить джобу. Возвращает её id. Не запускает обработку синхронно. */
export async function enqueue(kind, payload = {}) {
  const q = getQueue();
  const job = {
    id: `j_${nowTs()}_${Math.random().toString(36).slice(2, 6)}`,
    kind, payload, status: 'pending', tries: 0, addedAt: nowTs(),
  };
  q.push(job);
  await persist();
  start();            // «разбудить» воркер (не блокирует вызывающего)
  return job.id;
}

/** Запустить дренаж очереди (идемпотентно). Не await'им снаружи. */
export function start() {
  if (draining) return;
  draining = true;
  Promise.resolve().then(drain).catch((e) => {
    console.warn('[ChaoticLorebooks] job-queue drain error:', e);
  }).finally(() => { draining = false; });
}

async function drain() {
  const s = getSettings();
  // Дренируем во всех режимах, кроме lite (там фоновой памяти нет вовсе): balanced и
  // autonomous гонят ДЕШЁВЫЕ джобы (саммари арки, мёрж графа). Дорогие (аудит/deep-extract)
  // ставятся в очередь только в autonomous — на своих enqueue-сайтах. Backfill дренит даже в lite.
  if (!backgroundJobsAllowed(s) && !isBackfillActive()) return;
  const concurrency = Math.max(1, Math.min(2, s.autonomous?.concurrency ?? 1));

  // Простой цикл: берём pending-джобы, пока есть слоты и бюджет.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q = getQueue();
    const next = q.find((j) => j.status === 'pending');
    if (!next) {
      // Pending пусто и ничего не крутится → backfill сошёлся; чистим флаг и зовём колбэки.
      if (running === 0 && isBackfillActive()) {
        const meta = ctx().chatMetadata;
        if (meta) meta[BACKFILL_KEY] = false;
        await persist();
        fireDrained();
      }
      break;
    }
    if (running >= concurrency) break;
    if (!underBudget()) break;                        // упёрлись в budget cap

    running++;
    next.status = 'running';
    await persist();

    runJob(next).finally(() => { running--; start(); });

    if (running >= concurrency) break;                // запустили слот — отдаём цикл
  }
}

async function runJob(job) {
  const handler = handlers.get(job.kind);
  try {
    if (!handler) { job.status = 'failed'; job.error = 'no handler'; }
    else {
      await handler(job.payload, job);
      job.status = 'done';
    }
  } catch (e) {
    job.tries = (job.tries || 0) + 1;
    job.error = String(e?.message ?? e);
    job.status = job.tries >= 3 ? 'failed' : 'pending';   // до 3 ретраев
    console.warn(`[ChaoticLorebooks] job ${job.kind} failed (try ${job.tries}):`, e);
  } finally {
    pruneDone();
    await persist();
  }
}

// Не даём очереди раздуваться: чистим done/failed старше 5 минут (история — в activity-log позже).
function pruneDone() {
  const q = getQueue();
  const cutoff = nowTs() - 300_000;
  const kept = q.filter((j) => !((j.status === 'done' || j.status === 'failed') && j.addedAt < cutoff));
  if (kept.length !== q.length) { q.length = 0; q.push(...kept); }
}

/** Сводка для UI/диагностики. */
export function status() {
  const q = getQueue();
  const by = (st) => q.filter((j) => j.status === st).length;
  return {
    pending: by('pending'), running: by('running'),
    done: by('done'), failed: by('failed'), total: q.length,
  };
}

/** Сбросить любые «running» в pending (на старте сессии после рестарта ST). */
export function resumeAfterRestart() {
  const q = getQueue();
  let changed = false;
  for (const j of q) if (j.status === 'running') { j.status = 'pending'; changed = true; }
  if (changed) persist();
  start();
}
