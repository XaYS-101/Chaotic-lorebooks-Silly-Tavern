// job-queue.js — background worker with a persisted queue (SPEC §2, Phase A).
// All "expensive"/background work (arc summaries, graph merges, drift flags) runs
// HERE, off the reply critical path. The interceptor NEVER awaits the queue.
//
// Guarantees:
//   - persisted in chatMetadata → ST restart resumes pending jobs;
//   - concurrency 1-2 (autonomous.concurrency setting);
//   - budget cap on LLM calls per hour (autonomous.callsPerHour);
//   - degradation: a failed handler → job marked failed, chat unaffected.
//
// Markers: 🟢 framework (handlers may be 🟡).

import { getSettings, backgroundJobsAllowed } from './settings.js';

const QUEUE_KEY = 'chaoticLorebooks_queue';
const BACKFILL_KEY = 'chaoticLorebooks_backfillActive';

// Callbacks fired when the queue fully drains (used by backfill: wait until all
// arc-extracts finish, then run auto-hide + toast).
const drainedCallbacks = [];
export function onQueueDrained(fn) { if (typeof fn === 'function') drainedCallbacks.push(fn); }
function fireDrained() {
  for (const fn of drainedCallbacks.splice(0)) {
    try { Promise.resolve(fn()).catch((e) => console.warn('[ChaoticLorebooks] onDrained:', e)); }
    catch (e) { console.warn('[ChaoticLorebooks] onDrained:', e); }
  }
}

/** Toggle "backfill active": while on, extraction is allowed outside Autonomous. */
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

/** The queue is persisted in chat metadata. */
function getQueue() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[QUEUE_KEY])) meta[QUEUE_KEY] = [];
  return meta[QUEUE_KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

// Handler registry: kind → async (payload) => any. Registered by modules.
const handlers = new Map();
export function registerHandler(kind, fn) { handlers.set(kind, fn); }

// Rolling counter of LLM calls per hour (budget cap). In memory (per session).
let callTimestamps = [];
function underBudget() {
  const cap = getSettings().autonomous?.callsPerHour ?? 30;
  const hourAgo = nowTs() - 3600_000;
  callTimestamps = callTimestamps.filter((t) => t > hourAgo);
  return callTimestamps.length < cap;
}
/** A handler calls this before a paid LLM call (for budget accounting). */
export function noteLlmCall() { callTimestamps.push(nowTs()); }

// When the hourly budget is exhausted, drain() exits. Schedule a one-shot re-check
// so the queue resumes once the oldest call ages out (no external enqueue needed).
let budgetTimer = null;
function scheduleBudgetRecheck() {
  if (budgetTimer) return;
  const oldest = callTimestamps.length ? Math.min(...callTimestamps) : nowTs();
  const wait = Math.max(30_000, Math.min(300_000, (oldest + 3600_000) - nowTs() + 1000));
  budgetTimer = setTimeout(() => { budgetTimer = null; start(); }, wait);
}

let running = 0;
let draining = false;

/** Enqueue a job. Returns its id. Does not process synchronously. */
export async function enqueue(kind, payload = {}) {
  const q = getQueue();
  const job = {
    id: `j_${nowTs()}_${Math.random().toString(36).slice(2, 6)}`,
    kind, payload, status: 'pending', tries: 0, addedAt: nowTs(),
  };
  q.push(job);
  await persist();
  start();            // "wake" the worker (does not block the caller)
  return job.id;
}

/** Start draining the queue (idempotent). Not awaited externally. */
export function start() {
  if (draining) return;
  draining = true;
  Promise.resolve().then(drain).catch((e) => {
    console.warn('[ChaoticLorebooks] job-queue drain error:', e);
  }).finally(() => { draining = false; });
}

async function drain() {
  const s = getSettings();
  // Drain in every mode except lite (no background memory there): balanced and
  // autonomous run CHEAP jobs (arc summaries, graph merges). Expensive ones
  // (audit/deep-extract) are enqueued only in autonomous, at their own call sites.
  // Force jobs (manual re-run from UI, auto-regen of empty summaries) and backfill
  // run even in lite.
  if (!backgroundJobsAllowed(s) && !isBackfillActive()) {
    const hasForceJob = getQueue().some((j) => j.status === 'pending' && j.payload?.force);
    if (!hasForceJob) return;
  }
  const concurrency = Math.max(1, Math.min(2, s.autonomous?.concurrency ?? 1));

  // Simple loop: take pending jobs while slots and budget remain.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q = getQueue();
    const next = q.find((j) => j.status === 'pending');
    if (!next) {
      // Pending empty and nothing running → backfill converged; clear flag and fire callbacks.
      if (running === 0 && isBackfillActive()) {
        const meta = ctx().chatMetadata;
        if (meta) meta[BACKFILL_KEY] = false;
        await persist();
        fireDrained();
      }
      break;
    }
    if (running >= concurrency) break;
    if (!underBudget()) { scheduleBudgetRecheck(); break; } // hit the budget cap — resume later

    running++;
    next.status = 'running';
    await persist();

    runJob(next).finally(() => { running--; start(); });

    if (running >= concurrency) break;                // slot taken — yield the loop
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
    job.status = job.tries >= 3 ? 'failed' : 'pending';   // up to 3 retries
    console.warn(`[ChaoticLorebooks] job ${job.kind} failed (try ${job.tries}):`, e);
  } finally {
    if (job.status === 'failed') notifyJobFailed(job);
    pruneDone();
    await persist();
  }
}

/** Surface a permanently failed job to the user (toast + activity log). */
function notifyJobFailed(job) {
  try { globalThis.toastr?.warning?.(`Background memory task "${job.kind}" failed — see console.`); } catch { /* ok */ }
  import('../memory/activity-log.js')
    .then((m) => m.log?.({ kind: 'job-failed', detail: `${job.kind}: ${job.error || 'error'}` }))
    .catch(() => { /* activity log optional */ });
}

// Keep the queue from bloating: drop done/failed older than 5 min (history → activity-log later).
function pruneDone() {
  const q = getQueue();
  const cutoff = nowTs() - 300_000;
  const kept = q.filter((j) => !((j.status === 'done' || j.status === 'failed') && j.addedAt < cutoff));
  if (kept.length !== q.length) { q.length = 0; q.push(...kept); }
}

/** Summary for UI/diagnostics. */
export function status() {
  const q = getQueue();
  const by = (st) => q.filter((j) => j.status === st).length;
  return {
    pending: by('pending'), running: by('running'),
    done: by('done'), failed: by('failed'), total: q.length,
  };
}

/** Reset any "running" jobs back to pending (on session start after an ST restart). */
export function resumeAfterRestart() {
  const q = getQueue();
  let changed = false;
  for (const j of q) if (j.status === 'running') { j.status = 'pending'; changed = true; }
  if (changed) persist();
  start();
}
