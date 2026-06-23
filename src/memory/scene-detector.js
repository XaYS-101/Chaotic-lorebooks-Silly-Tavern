// scene-detector.js — детект сдвига сцены БЕЗ LLM (🟢). Решает: будить ли дешёвого
// агента и применять ли пенальти буферу.
//
// Два режима (settings.sceneDetector.algo):
//   'adaptive' (по умолчанию) — IDF-косинус дис-similarity между окном последних 3 соо
//     и окном 4-6 шагов назад, против ОНЛАЙН-порога (EWMA-среднее + EW-дисперсия → z-оценка)
//     плюс CUSUM на устойчивый сдвиг. IDF считается по самому чату → метрика
//     самокалибрующаяся, инвариантна к сеттингу/именам (не привязана к словам примера).
//     Почему не Jaccard: на разреженном мешке контент-слов он насыщается (~0.2-0.3 всегда)
//     и меряет оборот лексики, а не смену темы — низкий SNR, фиксированный порог = шум.
//   'legacy' — старый Jaccard + фиксированный порог (0.10+sens·0.25) ∨ newWordRatio.
//
// Онлайн-статистика и счётчики ходов живут в chatMetadata (chaoticLorebooks_sceneStats) →
// калибровка ПО КАЖДОМУ чату и устойчивость к перезагрузке/смене чата.

import { contentTokens, jaccard, buildIdf, tfidfCosine } from './text-relevance.js';
import { getSettings } from '../core/settings.js';
import { trace } from '../core/debug-trace.js';

const STATS_KEY = 'chaoticLorebooks_sceneStats';
const EPS = 1e-9;

function ctx() { try { return SillyTavern.getContext(); } catch { return null; } }
function freshStats() { return { turn: 0, lastWakeTurn: 0, mu: 0, var: 0, cusum: 0, count: 0 }; }

// In-memory fallback, когда метаданных чата нет (ранний старт). Метаданные приоритетны.
let mem = freshStats();

/** Объект статистики для мутации на месте: из chatMetadata (персист), иначе из памяти. */
function statsObj() {
  const meta = ctx()?.chatMetadata;
  if (!meta) return mem;
  if (!meta[STATS_KEY] || typeof meta[STATS_KEY] !== 'object') meta[STATS_KEY] = freshStats();
  return meta[STATS_KEY];
}

/** Оценить текущий ход. Возвращает {wake, shift, sim, score, newWordRatio}. */
export function evaluate() {
  const s = getSettings();
  const sd = s.sceneDetector ?? {};
  const st = statsObj();
  st.turn = (st.turn || 0) + 1;
  const turn = st.turn;

  const chat = ctx()?.chat ?? [];
  const recent = chat.slice(-3).flatMap((m) => contentTokens(m.mes));
  const prior = chat.slice(-6, -3).flatMap((m) => contentTokens(m.mes));

  // legacy-признаки (для трейса/сравнения и как fallback на warmup)
  const jac = jaccard(recent, prior);
  const priorSet = new Set(prior), recentSet = new Set(recent);
  let fresh = 0; for (const w of recentSet) if (!priorSet.has(w)) fresh++;
  const newWordRatio = recentSet.size ? fresh / recentSet.size : 0;

  // adaptive-сигнал: IDF-косинус по самому чату → дис-similarity d.
  const idf = buildIdf(chat.map((m) => contentTokens(m.mes)));
  const cos = tfidfCosine(recent, prior, idf);
  const d = 1 - cos;

  const sens = sd.sensitivity ?? 0.5;
  const adaptive = (sd.algo ?? 'adaptive') !== 'legacy';
  const warmup = (st.count || 0) < (sd.warmupTurns ?? 4);

  // z-оценка и CUSUM относительно ОНЛАЙН-базовой линии (до включения текущей точки).
  const sigma = Math.sqrt(Math.max(0, st.var || 0));
  const z = sigma > EPS ? (d - (st.mu || 0)) / sigma : 0;
  const kappa = sd.cusumSlack ?? 0.5;
  const h = sd.cusumThreshold ?? 5;
  const S = Math.max(0, (st.cusum || 0) + (d - (st.mu || 0) - kappa * sigma));
  const cusumFire = sigma > 1e-6 && S > h * sigma;

  let shift;
  if (!adaptive || warmup || prior.length === 0) {
    // legacy/warmup: старая формула (порог зависит от sensitivity).
    const sharedThreshold = 0.10 + sens * 0.25;
    const newWordThreshold = sd.newWordRatio ?? 0.5;
    shift = prior.length > 0 && (jac < sharedThreshold || newWordRatio >= newWordThreshold);
  } else {
    const k = 2.0 - sens * 1.5;   // sens 0 → k=2 (строго), 1 → k=0.5 (чутко)
    shift = (z > k) || cusumFire;
  }

  // Обновление онлайн-статистики (EWMA µ + EW-дисперсия по West) — всегда, и на warmup (прогрев).
  if (prior.length > 0) {
    const alpha = sd.ewmaAlpha ?? 0.2;
    const delta = d - (st.mu || 0);
    st.mu = (st.mu || 0) + alpha * delta;
    st.var = (1 - alpha) * ((st.var || 0) + alpha * delta * delta);
    st.cusum = cusumFire ? 0 : S;   // накопитель сбрасывается при срабатывании
    st.count = (st.count || 0) + 1;
  }

  // never-starve: будим не реже agentEveryNTurns, но и не реже жёсткого потолка maxTurnsCap.
  const soft = Math.max(1, s.agentEveryNTurns || 6);
  const hard = Math.max(soft, sd.maxTurnsCap ?? 8);
  const cap = shift ? soft : hard;
  const starved = (turn - (st.lastWakeTurn || 0)) >= cap;

  const wake = shift || starved;
  if (wake) st.lastWakeTurn = turn;

  trace('scene', {
    turn, wake, shift, starved,
    sim: Number(cos.toFixed(3)),                 // основной сигнал = IDF-косинус
    d: Number(d.toFixed(3)),
    z: Number(z.toFixed(3)),
    cusum: Number((st.cusum || 0).toFixed(3)),
    jac: Number(jac.toFixed(3)),                 // старый Jaccard — для сравнения
    newWordRatio: Number(newWordRatio.toFixed(3)),
  });
  return { wake, shift, sim: cos, score: d, newWordRatio };
}

/**
 * Сброс при смене чата. Сбрасываем только in-memory fallback: per-chat статистика живёт
 * в chatMetadata и подгружается сама для каждого чата (не теряем калибровку между сессиями).
 */
export function reset() { mem = freshStats(); }
