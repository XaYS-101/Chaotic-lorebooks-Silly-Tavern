// context-budget.js — global token ceiling for the ENTIRE memory injection (Phase D).
// Today each tier is trimmed by its own budget independently (recollection.budget,
// graph.budget; buffer/favorites — only by item count), with no shared limit, so
// together they can exceed any target. This module imposes ONE hard ceiling
// (contextBudget.target) over the assembled "memory bundle": fills by tier priority,
// on overflow condenses (drops whole lines/gists/edges, NEVER cuts mid-phrase), and
// drops lowest-priority tiers first.
//
// Pure code, no LLM. Degradation: no getTokenCountAsync → ~4 chars/token, chat is not
// blocked. review() only FLAGS pruning candidates (hard rule: nothing is deleted
// automatically — the user clicks "forget" themselves).
//
// Markers: 🟢. Depends only on settings + metadata (recollection).
//
// H5: unified scoring + MMR diversity (pure-code, no LLM).

import { getSettings } from '../core/settings.js';
import { contentTokens } from './text-relevance.js';

// --- Last build report (read by the UI for the memory health indicator) ---
let lastReport = null;
export function getLastReport() { return lastReport; }
export function setLastReport(r) { lastReport = r; }

function clampSig(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Estimate token count for text. Uses ST's exact counter if available, else ~4 chars/token.
 * @returns {Promise<number>}
 */
export async function estimate(text) {
  const t = String(text ?? '');
  if (!t) return 0;
  const c = SillyTavern.getContext();
  if (typeof c.getTokenCountAsync === 'function') {
    try {
      const n = await c.getTokenCountAsync(t, 0);
      if (Number.isFinite(n)) return n;
    } catch { /* fall back to the rough estimate */ }
  }
  return Math.ceil(t.length / 4);
}

/**
 * Trim a block to a token budget, KEEPING the header (first line, e.g.
 * "[Relationship graph …]") and dropping WHOLE body lines — so the injection never
 * becomes a phrase fragment. Lines are chosen by the cheap estimate (4 chars/token)
 * with a 10% margin so the result almost certainly fits under the exact counter. If
 * even the header doesn't fit → ''.
 * @returns {Promise<string>}
 */
export async function condense(text, tokenBudget) {
  const lines = String(text ?? '').split('\n');
  const header = lines[0] ?? '';
  const charBudget = Math.max(40, Math.floor((tokenBudget || 0) * 4 * 0.9));
  if (header.length > charBudget) return '';
  let out = header;
  for (let i = 1; i < lines.length; i++) {
    if (out.length + 1 + lines[i].length > charBudget) break;
    out += `\n${lines[i]}`;
  }
  return out;
}

/**
 * Global fit under the ceiling. blocks = [{tier, text, priority}] in assembly order.
 * Reserves room for memText (resurfacing, injected at a separate depth but counted
 * against the ceiling). Fills by descending priority; doesn't fully fit — condense;
 * even the header won't fit — drop the tier (logged to report.dropped). Returns text
 * in the ORIGINAL order (readability).
 * @param {Array<{tier:string,text:string,priority:number}>} blocks
 * @param {number} target token ceiling for all memory
 * @param {string} [memText] resurfacing text (reserved first)
 * @returns {Promise<{text:string, report:object}>}
 */
export async function fitBudget(blocks, target, memText) {
  const list = (blocks || []).filter((b) => b && b.text);
  list.forEach((b, i) => { b._ord = i; });

  const memTokens = memText ? await estimate(memText) : 0;
  const budget = Math.max(0, (target || 0) - memTokens);

  const byPri = list.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const perTier = {};
  const dropped = [];
  const kept = [];
  let used = 0;

  for (const b of byPri) {
    const remaining = budget - used;
    if (remaining <= 0) { dropped.push(b.tier); continue; }
    // eslint-disable-next-line no-await-in-loop
    const full = await estimate(b.text);
    if (full <= remaining) {
      b._final = b.text;
      used += full;
      perTier[b.tier] = (perTier[b.tier] || 0) + full;
      kept.push(b);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const cond = await condense(b.text, remaining);
    // eslint-disable-next-line no-await-in-loop
    const ct = cond ? await estimate(cond) : 0;
    if (cond && ct > 0 && ct <= remaining) {
      b._final = cond;
      used += ct;
      perTier[b.tier] = (perTier[b.tier] || 0) + ct;
      kept.push(b);
    } else {
      dropped.push(b.tier);
    }
  }

  kept.sort((a, b) => a._ord - b._ord);
  const text = kept.map((b) => b._final).join('\n\n');
  const report = {
    target: target || 0,
    used: used + memTokens,
    mem: memTokens,
    perTier,
    dropped,
    at: Date.now(),
  };
  setLastReport(report);
  return { text, report };
}

/**
 * Should the "Review" indicator be highlighted? true when memory has nearly filled
 * the ceiling. Pure code, no LLM. Controlled by contextBudget.autoReview.
 */
export function autoReview(report) {
  const s = getSettings();
  if (!s.contextBudget?.autoReview) return false;
  if (!report || !report.target) return false;
  return (report.used / report.target) >= 0.95;
}

/**
 * Code review of "what to prune": active low-significance gists (< lowThreshold),
 * oldest first — the main prunable injected tier. Mutates NOTHING, only returns a
 * candidate list (the UI offers a "forget" button = active=false, recoverable).
 * @returns {Promise<{candidates:Array<{kind,id,label,reason}>, summary:string}>}
 */
export async function review() {
  const s = getSettings();
  const lo = s.deepExtract?.lowThreshold ?? 0.3;
  const candidates = [];

  const { getGists } = await import('./recollection.js');
  const stale = getGists()
    .filter((g) => g.active !== false && clampSig(g.significance) < lo)
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
  for (const g of stale) {
    candidates.push({
      kind: 'gist',
      id: g.id,
      label: `arc ${g.arcId ?? '?'}: ${String(g.gist).slice(0, 60)}`,
      reason: `low significance ${clampSig(g.significance).toFixed(2)}`,
    });
  }

  const summary = candidates.length
    ? `${candidates.length} low-value recollection${candidates.length === 1 ? '' : 's'} — forget to free budget.`
    : 'Nothing stale to prune — memory is lean.';
  return { candidates, summary };
}

// --- H5: Unified scoring + MMR diversity (pure-code, no LLM) ---

/**
 * Unified score for a memory item, for the 0/1 knapsack.
 * score ∈ [0,1]; higher = more valuable to inject.
 *
 * @param {{text:string, recency?:number, weight?:number, significance?:number, centrality?:number}} item
 *   recency — freshness fraction [0,1] (1 = just now); weight — normalized buffer weight [0,1];
 *   significance — arc significance [0,1]; centrality — graph centrality [0,1].
 * @returns {number}
 */
export function scoreItem(item) {
  const s = getSettings().contextBudget;
  const w = s?.scoreWeights || {};
  const wr = w.recency ?? 0.35;
  const ww = w.bufferWeight ?? 0.25;
  const ws = w.significance ?? 0.25;
  const wc = w.centrality ?? 0.15;
  let score = 0, div = 0;
  if (item.recency != null) { score += wr * clamp(item.recency); div += wr; }
  if (item.weight != null) { score += ww * clamp(item.weight); div += ww; }
  if (item.significance != null) { score += ws * clamp(item.significance); div += ws; }
  if (item.centrality != null) { score += wc * clamp(item.centrality); div += wc; }
  return div > 0 ? score / div : 0.5;
}

/** Text similarity between two memory items (contentTokens → Jaccard). */
export function itemSimilarity(aText, bText) {
  const A = contentTokens(String(aText ?? ''));
  const B = contentTokens(String(bText ?? ''));
  if (!A.length || !B.length) return 0;
  const sa = new Set(A), sb = new Set(B);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * MMR (Maximal Marginal Relevance) selection: pick up to `maxTokens` tokens from
 * `candidates`, balancing unifiedScore and diversity (λ).
 *
 * @param {Array<{text:string, recency?, weight?, significance?, centrality?}>} candidates
 * @param {number} maxTokens — hard token ceiling
 * @param {number} [lambda=0.7] — relevance/diversity balance (1 = score only, 0 = diversity only)
 * @returns {Promise<Array>} selected items in descending MMR order
 */
export async function mmrSelect(candidates, maxTokens, lambda = 0.7) {
  if (!candidates.length) return [];
  const lam = Math.max(0, Math.min(1, lambda));
  const unselected = candidates.map((c, i) => ({ ...c, _idx: i }));
  const selected = [];
  let usedTokens = 0;

  while (unselected.length && usedTokens < maxTokens) {
    // Recompute MMR for each remaining candidate.
    let best = null, bestMMR = -Infinity, bestIdx = -1;
    for (let i = 0; i < unselected.length; i++) {
      const c = unselected[i];
      const s = scoreItem(c);
      // Diversity penalty: max similarity to any already-selected item.
      let maxSim = 0;
      for (const sel of selected) {
        const sim = itemSimilarity(c.text, sel.text);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lam * s - (1 - lam) * maxSim;
      if (mmr > bestMMR) { bestMMR = mmr; best = c; bestIdx = i; }
    }
    if (!best) break;

    // Check whether it fits the budget.
    const tokens = await estimate(best.text);
    if (usedTokens + tokens > maxTokens && selected.length > 0) break; // doesn't fit — stop

    selected.push(best);
    usedTokens += tokens;
    unselected.splice(bestIdx, 1);
  }

  return selected;
}

function clamp(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; }
