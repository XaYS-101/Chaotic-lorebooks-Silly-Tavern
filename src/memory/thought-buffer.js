// thought-buffer.js — ярус 1. Экспоненциальное затухание (half-life) + асимптотическое
// подкрепление + событийное пенальти при сдвиге сцены. Всё 🟢 (без LLM).
//
// Пункт: { id, text, kind:'goal|trait|lore|thread', subject, importance(1-3), weight, lastSeen }

import { getSettings } from '../core/settings.js';
import { contentTokens, stem } from './text-relevance.js';

const META_KEY = 'chaoticLorebooks_buffer';

// λ растёт с decayPerTurn; делится на important и множится на «летучесть» вида.
const LAMBDA_PER_UNIT = 0.35;
const KIND_VOLATILITY = { goal: 0.5, trait: 0.7, lore: 0.3, thread: 1 };
const DEFAULT_IMPORTANCE = { goal: 2, trait: 2, lore: 3, thread: 1 };
const STATE_KINDS = new Set(['trait', 'thread']);  // один пункт на (субъект, вид)
const REINFORCE_BETA = 0.5;   // W_new = ceil - (ceil - W_old)*β  (асимптотика к ceil)
const SCENE_PENALTY = 0.2;    // множитель к транзитным мыслям при сдвиге сцены
const DROP_FLOOR = 0.4;       // экспонента не достигает 0 → нужен явный пол
const SIM_THRESHOLD = 0.5;    // нечёткое совпадение целей/лора (Jaccard)

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

/** Добавить/подтвердить пункт (explicit upsert → вес сразу в потолок). */
export async function upsertItem({ text, kind = 'thread', subject, importance, replaceId }) {
  const buf = getBuffer();
  const subj = subjectOf(text, subject);
  const imp = clampImp(importance ?? DEFAULT_IMPORTANCE[kind] ?? 2);
  const target = replaceId ? buf.find((i) => i.id === replaceId)
    : findSimilar(buf, { text: text.trim(), kind, subject: subj });

  if (target) {
    target.text = text.trim(); target.kind = kind; target.subject = subj;
    target.importance = Math.max(target.importance || 1, imp);
    target.weight = ceilingOf(target);
    target.lastSeen = Date.now();
  } else {
    const it = { id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: text.trim(), kind, subject: subj, importance: imp, weight: 0, lastSeen: Date.now() };
    it.weight = ceilingOf(it);
    buf.push(it);
  }
  enforceCap(buf);
  await persist();
}

/** Один ход: экспоненциальный спад + выпадение + асимптотическое обогащение из сцены. */
export async function tickBuffer() {
  const s = getSettings().thoughtBuffer;
  if (!s.enabled) return;
  const buf = getBuffer();
  const lambdaBase = LAMBDA_PER_UNIT * (s.decayPerTurn || 1);

  // 1) экспоненциальный спад: W *= e^(-λ_eff)
  for (const it of buf) {
    const lambda = lambdaBase * (KIND_VOLATILITY[it.kind] ?? 1) / (it.importance || 1);
    it.weight *= Math.exp(-lambda);
  }
  // 2) выпадение ниже пола
  const floor = Math.max(s.dropThreshold ?? 0, DROP_FLOOR);
  const kept = buf.filter((it) => it.weight > floor);
  buf.length = 0; buf.push(...kept);

  // 3) асимптотическое обогащение: упомянуто в свежих соо → тянем к потолку
  const recent = new Set((ctx().chat ?? []).slice(-2).flatMap((m) => contentTokens(m.mes)));
  if (recent.size) {
    for (const it of buf) {
      const subjHit = it.subject && recent.has(it.subject);
      const wordHit = contentTokens(it.text).some((w) => recent.has(w));
      if (subjHit || wordHit) {
        const ceil = ceilingOf(it);
        it.weight = ceil - (ceil - it.weight) * REINFORCE_BETA;  // к ceil, не за него
        it.lastSeen = Date.now();
      }
    }
  }
  enforceCap(buf);
  await persist();
}

/** Пенальти при сдвиге сцены: транзитные (thread, imp<3) глушим; фундамент иммунен. */
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
  buf.sort((a, b) => (b.weight - a.weight) || (b.lastSeen - a.lastSeen));
  buf.length = s.maxItems;
}

export async function removeItem(id) {
  const buf = getBuffer(); const i = buf.findIndex((x) => x.id === id);
  if (i >= 0) { buf.splice(i, 1); await persist(); }
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
