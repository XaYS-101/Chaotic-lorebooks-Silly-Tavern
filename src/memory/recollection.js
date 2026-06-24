// recollection.js — tier 2 "recollections" (Phase B).
// Compressed gists of sealed arcs + graph refs + 2-4 verbatim voiceQuotes.
// Lives in chatMetadata (per-chat). Forgetting = active=false (natural decay by
// maxGists, manual toggle, bulk per arc).
//
// Injection is pure code (🟢), no LLM: active gists within a token budget.
// The gists themselves are produced by arc-summary (🟡) from the job queue.
//
// Markers: 🟢. Depends only on settings and metadata.

import { getSettings } from '../core/settings.js';

const KEY = 'chaoticLorebooks_recollection';

function ctx() { return SillyTavern.getContext(); }
function store() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[KEY])) meta[KEY] = [];
  return meta[KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

/** All gists (for UI). */
export function getGists() { return store(); }

/** Active gists (for injection). */
export function getActive() { return store().filter((g) => g.active !== false); }

/**
 * Add an arc gist. Dedup by arcId: re-processing an arc updates rather than duplicates.
 * `significance` (0..1, default 0.5) — decay priority: keep the important, filler
 * fades first. Set by deep-extractor; without it, neutral 0.5.
 * @param {{gist, graphRefs?, voiceQuotes?, arcId, significance?}} g
 */
export async function addGist(g) {
  if (!g?.gist) return null;
  const arr = store();
  const id = `r_${g.arcId ?? 'x'}_${Date.now().toString(36)}`;
  const quotesCap = Math.max(0, getSettings().recollection?.voiceQuotesPerArc ?? 3);
  const rec = {
    id,
    gist: String(g.gist),
    graphRefs: Array.isArray(g.graphRefs) ? g.graphRefs.slice(0, 12) : [],
    voiceQuotes: Array.isArray(g.voiceQuotes) ? g.voiceQuotes.slice(0, quotesCap) : [],
    active: true,
    arcId: g.arcId ?? null,
    significance: clampSig(g.significance),
    addedAt: Date.now(),
  };
  // if this arc already has a gist, replace it (an arc is processed once).
  const existIdx = arr.findIndex((x) => x.arcId != null && x.arcId === rec.arcId);
  if (existIdx >= 0) arr.splice(existIdx, 1, rec); else arr.push(rec);

  decayOverflow(arr);
  await persist();
  return id;
}

/** Significance in [0..1]; invalid → neutral 0.5. */
function clampSig(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Natural decay: keep at most maxGists ACTIVE. Deactivate (active=false, not
 * deleted — recoverable) the least significant first, ties broken by age (older
 * first). So filler fades before important arcs.
 */
function decayOverflow(arr) {
  const max = Math.max(1, getSettings().recollection?.maxGists ?? 12);
  const actives = arr.filter((x) => x.active !== false);
  if (actives.length <= max) return;
  actives.sort((a, b) => (clampSig(a.significance) - clampSig(b.significance))
    || ((a.addedAt ?? 0) - (b.addedAt ?? 0)));
  for (let i = 0; i < actives.length - max; i++) actives[i].active = false;
}

/**
 * Set an arc gist's significance (deep-extractor, after scoring). May re-run decay:
 * new filler could push out something less significant. Idempotent.
 */
export async function setSignificance(arcId, score) {
  const arr = store();
  const r = arr.find((x) => x.arcId != null && x.arcId === arcId);
  if (!r) return false;
  r.significance = clampSig(score);
  decayOverflow(arr);
  await persist();
  return true;
}

/** Toggle the active flag of one gist. */
export async function setActive(id, active) {
  const r = store().find((x) => x.id === id);
  if (!r) return false;
  r.active = !!active;
  await persist();
  return true;
}

/** Bulk: enable/disable all gists of an arc ("forgot this arc" / "remembered"). */
export async function bulkSetArc(arcId, active) {
  let changed = false;
  for (const r of store()) if (r.arcId === arcId) { r.active = !!active; changed = true; }
  if (changed) await persist();
  return changed;
}

/** Delete a gist permanently. */
export async function removeGist(id) {
  const arr = store();
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) return false;
  arr.splice(i, 1);
  await persist();
  return true;
}

/**
 * Build the tier-2 injection within a token budget (🟢, no LLM).
 * Gists (ascending by arc) + verbatim voiceQuotes. Returns a string or ''.
 */
export async function renderForInjection(budget) {
  const s = getSettings();
  if (s.recollection?.enabled === false) return '';
  const actives = getActive().slice();
  if (!actives.length) return '';

  const tokenBudget = budget ?? s.recollection?.budget ?? 500;

  // H5: for >5 active gists use MMR selection (diversity); otherwise
  // chronological order (legacy behavior).
  let selected;
  if (actives.length > 5) {
    const now = Date.now();
    const candidates = actives.map((r) => ({
      text: [r.gist, ...(r.voiceQuotes || []).map((q) => `» ${q}`)].join('\n'),
      recency: r.addedAt ? Math.max(0, 1 - (now - r.addedAt) / (1000 * 60 * 60 * 24 * 30)) : 0.5,
      significance: typeof r.significance === 'number' ? r.significance : 0.5,
    }));
    const { mmrSelect } = await import('./context-budget.js');
    selected = await mmrSelect(candidates, tokenBudget, 0.75);
  } else {
    selected = actives.slice().sort((a, b) => (a.arcId ?? 0) - (b.arcId ?? 0)).map((r) => ({
      text: [r.gist, ...(r.voiceQuotes || []).map((q) => `» ${q}`)].join('\n'),
    }));
  }

  const body = selected.map((s) => s.text).join('\n');
  const trimmed = await trimToBudget(body, tokenBudget);
  if (!trimmed) return '';
  return `[Recollections — condensed memory of earlier scenes]\n${trimmed}`;
}

/** Trim text to a token budget (ST's exact counter if available, else ~4 chars/token). */
async function trimToBudget(text, tokenBudget) {
  const lines = String(text).split('\n');
  const c = ctx();
  if (typeof c.getTokenCountAsync === 'function') {
    let out = [];
    for (const l of lines) {
      const candidate = [...out, l].join('\n');
      // count cumulatively; costly, but there are few lines
      // eslint-disable-next-line no-await-in-loop
      const n = await c.getTokenCountAsync(candidate, 0).catch(() => candidate.length / 4);
      if (n > tokenBudget) break;
      out.push(l);
    }
    return out.join('\n');
  }
  const charBudget = Math.max(120, tokenBudget * 4);
  if (text.length <= charBudget) return text;
  let out = '';
  for (const l of lines) { if (out.length + l.length + 1 > charBudget) break; out += (out ? '\n' : '') + l; }
  return out;
}
