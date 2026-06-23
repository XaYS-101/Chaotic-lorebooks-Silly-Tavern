// scene-detector.js — детект сдвига сцены БЕЗ LLM (🟢). Сравнивает окно последних
// 3 соо с окном 4-6 шагов назад по доле общих слов (Jaccard). Управляется ползунком
// чувствительности. Решает: будить ли дешёвого агента и применять ли пенальти буферу.

import { contentTokens, jaccard } from './text-relevance.js';
import { getSettings } from '../core/settings.js';
import { trace } from '../core/debug-trace.js';

let turn = 0;
let lastWakeTurn = 0;

/** Оценить текущий ход. Возвращает {wake, shift, sim, score}. */
export function evaluate() {
  const s = getSettings();
  turn++;
  const chat = SillyTavern.getContext().chat ?? [];
  const recent = chat.slice(-3).flatMap((m) => contentTokens(m.mes));
  const prior = chat.slice(-6, -3).flatMap((m) => contentTokens(m.mes));
  const sim = jaccard(recent, prior);           // доля общих уникальных слов

  // sensitivity 1 → порог 0.35 (легко считаем сдвигом), 0 → 0.10 (строго)
  const sens = s.sceneDetector?.sensitivity ?? 0.5;
  const sharedThreshold = 0.10 + sens * 0.25;

  // Доля НОВЫХ слов в свежем окне (динамический троттлинг): много нового → сдвиг.
  const priorSet = new Set(prior);
  const recentSet = new Set(recent);
  let fresh = 0; for (const w of recentSet) if (!priorSet.has(w)) fresh++;
  const newWordRatio = recentSet.size ? fresh / recentSet.size : 0;
  const newWordThreshold = s.sceneDetector?.newWordRatio ?? 0.5;

  const shift = prior.length > 0 && (sim < sharedThreshold || newWordRatio >= newWordThreshold);

  // never-starve: будим не реже agentEveryNTurns, но и не реже жёсткого потолка
  // maxTurnsCap (динамика: статичная сцена тянет к потолку, активная — чаще).
  const soft = Math.max(1, s.agentEveryNTurns || 6);
  const hard = Math.max(soft, s.sceneDetector?.maxTurnsCap ?? 8);
  const cap = shift ? soft : hard;
  const starved = (turn - lastWakeTurn) >= cap;

  const wake = shift || starved;
  if (wake) lastWakeTurn = turn;
  trace('scene', { turn, wake, shift, starved, sim: Number(sim.toFixed(3)), newWordRatio: Number(newWordRatio.toFixed(3)) });
  return { wake, shift, sim, score: 1 - sim, newWordRatio };
}

/** Сброс при смене чата (счётчики — в памяти). */
export function reset() { turn = 0; lastWakeTurn = 0; }
