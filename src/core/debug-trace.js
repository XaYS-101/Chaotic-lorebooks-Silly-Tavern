// debug-trace.js — кольцевой буфер диагностических событий + экспорт снимка
// состояния в JSON-файл. Всё локально, без LLM и без записи в книгу. Когда
// debug.enabled выключен, trace() — no-op; на поведение памяти не влияет.

import { getSettings } from './settings.js';
import { getLog } from '../memory/activity-log.js';

const ARCS_KEY = 'chaoticLorebooks_arcs';
const BUFFER_KEY = 'chaoticLorebooks_buffer';
const WM_KEY = 'chaoticLorebooks_watermark';
const SCENE_STATS_KEY = 'chaoticLorebooks_sceneStats';
const HARD_CAP = 2000;            // backstop, чтобы буфер не рос без предела

let ring = [];

function ctx() { try { return SillyTavern.getContext(); } catch { return null; } }
function cap() {
  const n = getSettings().debug?.traceCap ?? 500;
  return Math.max(50, Math.min(HARD_CAP, n));
}

/** Записать одно событие. No-op при выключенной отладке. Никогда не бросает. */
export function trace(ev, data = {}) {
  try {
    if (!getSettings().debug?.enabled || !ev) return;
    ring.push({ t: Date.now(), ev: String(ev), ...data });
    const c = cap();
    if (ring.length > c) ring.splice(0, ring.length - c);
  } catch { /* отладка не должна мешать работе */ }
}

/** Копия трейса (новые в конце). */
export function getTrace() { return ring.slice(); }

/** Очистить трейс. */
export function clearTrace() { ring = []; }

// Глубокая копия настроек с замазкой ключей API.
function redactSettings(s) {
  let clone;
  try { clone = JSON.parse(JSON.stringify(s ?? {})); } catch { return {}; }
  const profiles = clone?.api?.profiles;
  if (Array.isArray(profiles)) {
    for (const p of profiles) { if (p && p.key) p.key = '***'; }
  }
  return clone;
}

/** Собрать снимок диагностики: настройки (с замазкой) + состояние чата + трейс. */
export function buildDiagnostics() {
  const c = ctx();
  const meta = c?.chatMetadata ?? {};
  const chatId = c?.getCurrentChatId?.() ?? null;
  const chat = c?.chat ?? [];
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      extension: 'chaoticLorebooks',
      branch: 'testing',
    },
    settings: redactSettings(getSettings()),
    chat: {
      id: chatId,
      length: chat.length,
      watermark: meta[WM_KEY] ?? -1,
    },
    arcs: Array.isArray(meta[ARCS_KEY]) ? meta[ARCS_KEY] : [],
    buffer: Array.isArray(meta[BUFFER_KEY]) ? meta[BUFFER_KEY] : [],
    sceneStats: (meta[SCENE_STATS_KEY] && typeof meta[SCENE_STATS_KEY] === 'object') ? meta[SCENE_STATS_KEY] : null,
    activityLog: getLog(),
    trace: getTrace(),
  };
}

// Безопасное имя файла из id чата.
function safeName(id) {
  return String(id || 'chat').replace(/[^\w.-]+/g, '_').slice(0, 60);
}

/** Скачать диагностику как JSON-файл (Blob + временная ссылка). */
export function downloadDiagnostics() {
  try {
    const diag = buildDiagnostics();
    const json = JSON.stringify(diag, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chaotic-diagnostics-${safeName(diag.chat.id)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) {
    console.warn('[ChaoticLorebooks] diagnostics download failed:', e);
    return false;
  }
}
