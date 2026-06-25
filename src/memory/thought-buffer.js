// thought-buffer.js — tier 1. ACT-R activation (power-law decay, not exponential)
// + asymptotic reinforcement + scene-shift event penalty. All 🟢 (no LLM).
//
// Item: { id, text, kind, subject, importance(1-3), weight, lastSeen, mentionCount, createdTurn }

import { getSettings } from '../core/settings.js';
import { contentTokens, stem } from './text-relevance.js';
import { trace } from '../core/debug-trace.js';

const META_KEY = 'chaoticLorebooks_buffer';
const TURN_KEY = 'chaoticLorebooks_sceneStats'; // turn counter lives here

// Allowed buffer item kinds (for the UI edit dropdown).
export const BUFFER_KINDS = ['goal', 'trait', 'lore', 'thread'];

// ACT-R: power-law decay (d=0.5 — standard value from cognitive psychology).
// A = ln(Σ t_j^(-d)) — sum over all mentions; weight = ceil · A_norm.
const ACTR_DECAY = 0.5;
// Salience by kind (half-life multiplier): higher → decays slower.
const KIND_SALIENCE = { goal: 1.5, trait: 1.0, lore: 0.8, thread: 0.5 };
const DEFAULT_IMPORTANCE = { goal: 2, trait: 2, lore: 3, thread: 1 };
const STATE_KINDS = new Set(['trait', 'thread']);  // one item per (subject, kind)
const CONSTANT_KINDS = new Set(['trait', 'lore']); // "constant" tier at importance 3
const REINFORCE_BETA = 0.5;   // W_new = ceil - (ceil - W_old)*β  (asymptote toward ceil)
const SCENE_PENALTY = 0.2;    // multiplier on transient thoughts at scene shift
const DROP_FLOOR = 0.3;       // normalized activation below this → drop
const SIM_THRESHOLD = 0.5;    // fuzzy match for goals/lore (Jaccard)
const MAX_GOAL_AGE = 20;      // goals older than this (turns) without reinforcement → expire

// "Constant": important (importance 3) trait/feeling/lore — behaves like a pin:
// never decays, never drops by floor, never evicted by the cap.
const isConstant = (it) => (it.importance || 1) >= 3 && CONSTANT_KINDS.has(it.kind);

/** Current turn number (from sceneStats, else chat length). */
function currentTurn() {
  const meta = SillyTavern.getContext().chatMetadata;
  if (meta?.[TURN_KEY]?.turn) return meta[TURN_KEY].turn;
  return (SillyTavern.getContext().chat ?? []).length;
}

function ctx() { return SillyTavern.getContext(); }
export function getBuffer() {
  const meta = ctx().chatMetadata;
  if (!Array.isArray(meta[META_KEY])) meta[META_KEY] = [];
  return meta[META_KEY];
}
async function persist() { await ctx().saveMetadata(); }

const ceilingOf = (it) => getSettings().thoughtBuffer.startWeight * (it.importance || 1);
function jac(a, b) {
  const A = new Set(contentTokens(a)), B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}
function subjectOf(text, explicit) {
  if (explicit) return stem(String(explicit).toLowerCase());
  const m = String(text).match(/\b([A-ZА-ЯЁ][\wа-яё]+)/);
  return stem((m ? m[1] : String(text).split(/\s+/)[0] || '').toLowerCase());
}
function clampImp(v) { return Math.max(1, Math.min(3, Math.round(v) || 2)); }

function findSimilar(buf, { text, kind, subject }) {
  if (STATE_KINDS.has(kind)) return buf.find((i) => i.kind === kind && i.subject === subject) || null;
  return buf.find((i) => i.kind === kind && jac(i.text, text) >= SIM_THRESHOLD) || null;
}

/** Add/confirm an item (explicit upsert → weight goes straight to ceiling). */
export async function upsertItem({ text, kind = 'thread', subject, importance, replaceId }) {
  const buf = getBuffer();
  const subj = subjectOf(text, subject);
  const explicitImp = importance != null;       // caller explicitly overrides importance
  const imp = clampImp(importance ?? DEFAULT_IMPORTANCE[kind] ?? 2);
  const turn = currentTurn();
  const target = replaceId ? buf.find((i) => i.id === replaceId)
    : findSimilar(buf, { text: text.trim(), kind, subject: subj });

  if (target) {
    target.text = text.trim(); target.kind = kind; target.subject = subj;
    // Explicit importance from the LLM may also LOWER it (otherwise a trait once set
    // to constant 3 would pin forever); without explicit, take the monotonic max
    // (confirmation never lowers).
    target.importance = explicitImp ? imp : Math.max(target.importance || 1, imp);
    // Reinforce: append this turn to the mention history.
    target.mentionCount = (target.mentionCount || 1) + 1;
    if (!Array.isArray(target.mentionTurns)) target.mentionTurns = [];
    target.mentionTurns.push(turn);
    if (target.mentionTurns.length > 12) target.mentionTurns = target.mentionTurns.slice(-8);
    target.lastSeen = turn;
    target.weight = ceilingOf(target); // reinforcement → ceiling
  } else {
    const it = { id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: text.trim(), kind, subject: subj, importance: imp, weight: 0,
      lastSeen: turn, mentionCount: 1, mentionTurns: [turn], createdTurn: turn };
    it.weight = ceilingOf(it);
    buf.push(it);
  }
  trace('buffer.upsert', { kind, subject: subj, text: String(text).slice(0, 80), hit: !!target });
  enforceCap(buf);
  await persist();
}

/** One turn: ACT-R decay + drop + scene reinforcement + goal expiry. */
export async function tickBuffer() {
  const s = getSettings().thoughtBuffer;
  if (!s.enabled) return;
  const buf = getBuffer();
  const turn = currentTurn();
  const decayMul = s.decayPerTurn ?? 1; // >1 speeds decay, <1 slows it

  // 1) ACT-R activation → weight. Constants never decay.
  for (const it of buf) {
    if (isConstant(it)) continue; // pinned — always at ceiling

    // Goal lifecycle: a goal older than maxGoalAge without reinforcement → expire.
    if (it.kind === 'goal' && it.createdTurn && (turn - it.lastSeen) > MAX_GOAL_AGE) {
      it.weight = 0; // dropped in step 2
      continue;
    }

    // ACT-R base-level activation: A = ln(Σ (turn - t_j)^(-d)).
    const mentions = Array.isArray(it.mentionTurns) && it.mentionTurns.length
      ? it.mentionTurns : [it.createdTurn || it.lastSeen || turn];
    let actrSum = 0;
    for (const t of mentions) {
      const lag = Math.max(1, (turn - t) * decayMul);
      actrSum += Math.pow(lag, -ACTR_DECAY);
    }

    // Apply the ln() compression so a long mention history doesn't dominate;
    // +1 keeps activation non-negative for normalization.
    const activation = Math.log(1 + actrSum);
    // Salience: importance × kindWeight → half-life factor.
    const salience = (it.importance || 1) * (KIND_SALIENCE[it.kind] ?? 1);
    // Normalize against all-at-lag=1 (the theoretical max for this mention count),
    // so items with a long history aren't penalized by a larger denominator.
    const maxActivation = Math.log(1 + mentions.length);
    const norm = maxActivation > 0 ? Math.min(1, activation / maxActivation) * salience / 3 : 0;
    it.weight = norm * ceilingOf(it);
    it.lastSeen = turn;
  }

  // 2) Drop below floor — except constants. Expired goals (weight=0) also drop.
  const floor = (s.dropThreshold ?? DROP_FLOOR) * (ceilingOf({ importance: 1 }) || 5) / 5;
  const kept = buf.filter((it) => isConstant(it) || it.weight > floor);
  buf.length = 0; buf.push(...kept);

  // 3) Asymptotic reinforcement: mentioned in recent messages → pull toward ceiling.
  const recent = new Set((ctx().chat ?? []).slice(-2).flatMap((m) => contentTokens(m.mes)));
  if (recent.size) {
    for (const it of buf) {
      const subjHit = it.subject && recent.has(it.subject);
      const wordHit = contentTokens(it.text).some((w) => recent.has(w));
      if (subjHit || wordHit) {
        const ceil = ceilingOf(it);
        it.weight = ceil - (ceil - it.weight) * REINFORCE_BETA;  // toward ceil, not past it
        it.lastSeen = turn;
        if (!Array.isArray(it.mentionTurns)) it.mentionTurns = [];
        it.mentionTurns.push(turn);
        if (it.mentionTurns.length > 12) it.mentionTurns = it.mentionTurns.slice(-8);
      }
    }
  }
  enforceCap(buf);
  await persist();
}

/** Scene-shift penalty: damp transient items (thread, imp<3); foundation is immune. */
export async function applyScenePenalty() {
  const buf = getBuffer();
  let changed = false;
  for (const it of buf) {
    if (it.kind === 'thread' && (it.importance || 1) < 3) { it.weight *= SCENE_PENALTY; changed = true; }
  }
  if (changed) { enforceCap(buf); await persist(); }
}

export async function decayTick() { await tickBuffer(); }

function enforceCap(buf) {
  const s = getSettings().thoughtBuffer;
  if (!s.limitEnabled) return;
  if (buf.length <= s.maxItems) return;
  // Constants are prioritized (pin tier) but are STILL bounded by the cap — otherwise
  // with constants ≥ maxItems the buffer would grow unbounded. Keep top-by-weight
  // constants, then fill with regular items up to maxItems. Hard guarantee: buf.length ≤ maxItems.
  const byWeight = (a, b) => (b.weight - a.weight) || (b.lastSeen - a.lastSeen);
  // Cap constants separately (maxConstants) so they can't crowd out regular
  // thoughts entirely; still bounded by maxItems overall.
  const constCap = Math.max(0, Math.min(s.maxConstants ?? s.maxItems, s.maxItems));
  const consts = buf.filter(isConstant).sort(byWeight).slice(0, constCap);
  const rest = buf.filter((it) => !isConstant(it)).sort(byWeight);
  const room = Math.max(0, s.maxItems - consts.length);
  const next = [...consts, ...rest.slice(0, room)];
  buf.length = 0; buf.push(...next);
}

export async function removeItem(id) {
  const buf = getBuffer(); const i = buf.findIndex((x) => x.id === id);
  if (i >= 0) { buf.splice(i, 1); await persist(); }
}

/**
 * Manual edit of a buffer item from the UI. Text required; kind/importance optional.
 * Subject is recomputed from the new text (if none passed explicitly). Weight is NOT
 * touched (rewording shouldn't lower or raise relevance). Returns true if anything changed.
 */
export async function editItem(id, { text, kind, importance } = {}) {
  const buf = getBuffer();
  const it = buf.find((x) => x.id === id);
  if (!it) return false;
  let changed = false;
  if (text != null) {
    const tt = String(text).trim();
    if (tt && tt !== it.text) {
      it.text = tt;
      it.subject = subjectOf(tt, null);
      changed = true;
    }
  }
  if (kind && kind !== it.kind) { it.kind = kind; changed = true; }
  if (importance != null) {
    const imp = clampImp(importance);
    if (imp !== it.importance) {
      it.importance = imp;
      it.weight = Math.min(it.weight, ceilingOf(it)); // no higher than the new ceiling
      changed = true;
    }
  }
  if (changed) { it.lastSeen = currentTurn(); enforceCap(buf); await persist(); }
  return changed;
}
export async function clearBuffer() { const buf = getBuffer(); buf.length = 0; await persist(); }

export function renderForInjection() {
  const s = getSettings().thoughtBuffer;
  if (!s.enabled) return '';
  const buf = getBuffer();
  if (!buf.length) return '';
  const lines = buf.slice().sort((a, b) => b.weight - a.weight).map((i) => `- (${i.kind}) ${i.text}`);
  return `[Current mental state — keep in character, do not state these aloud verbatim]\n${lines.join('\n')}`;
}
