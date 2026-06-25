// scene-detector.js — scene-shift detection WITHOUT LLM (🟢). Decides whether to wake
// the cheap agent and whether to penalize the buffer.
//
// Two modes (settings.sceneDetector.algo):
//   'adaptive' (default) — IDF-cosine dissimilarity between the window of the last 3
//     messages and the window 4-6 steps back, against an ONLINE threshold (EWMA mean +
//     EW-variance → z-score) plus CUSUM for a sustained shift. IDF is computed from the
//     chat itself, so the metric self-calibrates and is invariant to setting/names.
//     Why not Jaccard: on a sparse bag of content words it saturates (~0.2-0.3 always)
//     and measures vocabulary churn, not topic change — low SNR, fixed threshold = noise.
//   'legacy' — old Jaccard + fixed threshold (0.10+sens·0.25) ∨ newWordRatio.
//
// Online stats and turn counters live in chatMetadata (chaoticLorebooks_sceneStats) →
// per-chat calibration and resilience across reload/chat switch.

import { contentTokens, jaccard, buildIdf, tfidfCosine } from './text-relevance.js';
import { getSettings } from '../core/settings.js';
import { trace } from '../core/debug-trace.js';

const STATS_KEY = 'chaoticLorebooks_sceneStats';
const EPS = 1e-9;

function ctx() { try { return SillyTavern.getContext(); } catch { return null; } }
function freshStats() { return { turn: 0, lastWakeTurn: 0, mu: 0, var: 0, cusum: 0, count: 0 }; }

// In-memory fallback when chat metadata is absent (early start). Metadata takes priority.
let mem = freshStats();

/** Stats object for in-place mutation: from chatMetadata (persisted), else from memory. */
function statsObj() {
  const meta = ctx()?.chatMetadata;
  if (!meta) return mem;
  if (!meta[STATS_KEY] || typeof meta[STATS_KEY] !== 'object') meta[STATS_KEY] = freshStats();
  return meta[STATS_KEY];
}

/** Evaluate the current turn. Returns {wake, shift, sim, score, newWordRatio}. */
export function evaluate() {
  const s = getSettings();
  const sd = s.sceneDetector ?? {};
  const st = statsObj();
  st.turn = (st.turn || 0) + 1;
  const turn = st.turn;

  const chat = ctx()?.chat ?? [];
  const recent = chat.slice(-3).flatMap((m) => contentTokens(m.mes));
  const prior = chat.slice(-6, -3).flatMap((m) => contentTokens(m.mes));

  // legacy signals (for trace/comparison and as a warmup fallback)
  const jac = jaccard(recent, prior);
  const priorSet = new Set(prior), recentSet = new Set(recent);
  let fresh = 0; for (const w of recentSet) if (!priorSet.has(w)) fresh++;
  const newWordRatio = recentSet.size ? fresh / recentSet.size : 0;

  // adaptive signal: IDF-cosine over the chat itself → dissimilarity d.
  // Drop empty token docs (very short/system messages) so buildIdf/cosine can't yield NaN.
  const tokenDocs = chat.map((m) => contentTokens(m.mes)).filter((toks) => toks.length);
  const idf = tokenDocs.length ? buildIdf(tokenDocs) : buildIdf([['']]);
  const cosRaw = tfidfCosine(recent, prior, idf);
  const cos = Number.isFinite(cosRaw) ? cosRaw : 0;
  const d = 1 - cos;

  const sens = sd.sensitivity ?? 0.5;
  const adaptive = (sd.algo ?? 'adaptive') !== 'legacy';
  const warmup = (st.count || 0) < (sd.warmupTurns ?? 4);

  // z-score and CUSUM against the ONLINE baseline (before folding in the current point).
  const sigma = Math.sqrt(Math.max(0, st.var || 0));
  const z = sigma > EPS ? (d - (st.mu || 0)) / sigma : 0;
  const kappa = sd.cusumSlack ?? 0.5;
  const h = sd.cusumThreshold ?? 5;
  const S = Math.max(0, (st.cusum || 0) + (d - (st.mu || 0) - kappa * sigma));
  const cusumFire = sigma > 1e-6 && S > h * sigma;

  let shift;
  if (!adaptive || warmup || prior.length === 0) {
    // legacy/warmup: old formula (threshold depends on sensitivity).
    const sharedThreshold = 0.10 + sens * 0.25;
    const newWordThreshold = sd.newWordRatio ?? 0.5;
    shift = prior.length > 0 && (jac < sharedThreshold || newWordRatio >= newWordThreshold);
  } else {
    const k = 2.0 - sens * 1.5;   // sens 0 → k=2 (strict), 1 → k=0.5 (sensitive)
    shift = (z > k) || cusumFire;
  }

  // Update online stats (EWMA µ + EW-variance, West's method) — always, including warmup.
  if (prior.length > 0) {
    const alpha = sd.ewmaAlpha ?? 0.2;
    const delta = d - (st.mu || 0);
    st.mu = (st.mu || 0) + alpha * delta;
    st.var = (1 - alpha) * ((st.var || 0) + alpha * delta * delta);
    st.cusum = cusumFire ? 0 : S;   // accumulator resets when it fires
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
    sim: Number(cos.toFixed(3)),                 // primary signal = IDF-cosine
    d: Number(d.toFixed(3)),
    z: Number(z.toFixed(3)),
    cusum: Number((st.cusum || 0).toFixed(3)),
    jac: Number(jac.toFixed(3)),                 // old Jaccard — for comparison
    newWordRatio: Number(newWordRatio.toFixed(3)),
  });
  return { wake, shift, sim: cos, score: d, newWordRatio };
}

/**
 * Reset on chat switch. Only the in-memory fallback is cleared: per-chat stats live in
 * chatMetadata and reload per chat (calibration is not lost across sessions).
 */
export function reset() { mem = freshStats(); }
