// thought-buffer.js — ярус 1. ACT-R активация (степенное затухание вместо экспоненты)
// + асимптотическое подкрепление + событийное пенальти при сдвиге сцены. Всё 🟢 (без LLM).
//
// Пункт: { id, text, kind, subject, importance(1-3), weight, lastSeen, mentionCount, createdTurn }

import { getSettings } from '../core/settings.js';
import { contentTokens, stem } from './text-relevance.js';
import { trace } from '../core/debug-trace.js';

const META_KEY = 'chaoticLorebooks_buffer';
const TURN_KEY = 'chaoticLorebooks_sceneStats'; // turn counter lives here

// Допустимые виды пункта буфера (для UI-дропдауна правки).
export const BUFFER_KINDS = ['goal', 'trait', 'lore', 'thread'];

// ACT-R: степенной декей (d=0.5 — стандартное значение из когнитивной психологии).
// A = ln(Σ t_j^(-d)) — сумма по всем упоминаниям; weight = ceil · A_norm.
const ACTR_DECAY = 0.5;
// Сальность по виду (множитель half-life): выше → медленнее тухнет.
const KIND_SALIENCE = { goal: 1.5, trait: 1.0, lore: 0.8, thread: 0.5 };
const DEFAULT_IMPORTANCE = { goal: 2, trait: 2, lore: 3, thread: 1 };
const STATE_KINDS = new Set(['trait', 'thread']);  // один пункт на (субъект, вид)
const CONSTANT_KINDS = new Set(['trait', 'lore']); // ярус «констант» при importance 3
const REINFORCE_BETA = 0.5;   // W_new = ceil - (ceil - W_old)*β  (асимптотика к ceil)
const SCENE_PENALTY = 0.2;    // множитель к транзитным мыслям при сдвиге сцены
const DROP_FLOOR = 0.3;       // нормализованная активация ниже этого → выпадение
const SIM_THRESHOLD = 0.5;    // нечёткое совпадение целей/лора (Jaccard)
const MAX_GOAL_AGE = 20;      // цели старше этого (в ходах) без подкрепления → expire

// «Константа»: важная (importance 3) черта/чувство/лор — ведёт себя как пин:
// не тухнет, не выпадает по полу, не вытесняется лимитом.
const isConstant = (it) => (it.importance || 1) >= 3 && CONSTANT_KINDS.has(it.kind);

/** Текущий номер хода (из sceneStats, иначе длина чата). */
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

/** Добавить/подтвердить пункт (explicit upsert → вес сразу в потолок). */
export async function upsertItem({ text, kind = 'thread', subject, importance, replaceId }) {
  const buf = getBuffer();
  const subj = subjectOf(text, subject);
  const explicitImp = importance != null;       // явная переоценка важности от вызывающего
  const imp = clampImp(importance ?? DEFAULT_IMPORTANCE[kind] ?? 2);
  const turn = currentTurn();
  const target = replaceId ? buf.find((i) => i.id === replaceId)
    : findSimilar(buf, { text: text.trim(), kind, subject: subj });

  if (target) {
    target.text = text.trim(); target.kind = kind; target.subject = subj;
    // Явная важность от LLM может и ПОНИЗИТЬ (иначе раз ставшая 3 черта-константа
    // пиннилась бы навсегда); без явной — монотонный максимум (подтверждение не роняет).
    target.importance = explicitImp ? imp : Math.max(target.importance || 1, imp);
    // Подкрепление: добавить ход в историю упоминаний.
    target.mentionCount = (target.mentionCount || 1) + 1;
    if (!Array.isArray(target.mentionTurns)) target.mentionTurns = [];
    target.mentionTurns.push(turn);
    if (target.mentionTurns.length > 12) target.mentionTurns = target.mentionTurns.slice(-8);
    target.lastSeen = turn;
    target.weight = ceilingOf(target); // подкрепление → в потолок
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

/** Один ход: ACT-R спад + выпадение + обогащение из сцены + goal expiry. */
export async function tickBuffer() {
  const s = getSettings().thoughtBuffer;
  if (!s.enabled) return;
  const buf = getBuffer();
  const turn = currentTurn();
  const decayMul = s.decayPerTurn ?? 1; // >1 ускоряет декей, <1 замедляет

  // 1) ACT-R активация → вес. Константы не тухнут.
  for (const it of buf) {
    if (isConstant(it)) continue; // пин — всегда в потолке

    // Goal lifecycle: если цель старше maxGoalAge без подкрепления → expire.
    if (it.kind === 'goal' && it.createdTurn && (turn - it.lastSeen) > MAX_GOAL_AGE) {
      it.weight = 0; // выпадет в шаге 2
      continue;
    }

    // ACT-R: A = ln(Σ (turn - t_j)^(-d))
    const mentions = Array.isArray(it.mentionTurns) && it.mentionTurns.length
      ? it.mentionTurns : [it.createdTurn || it.lastSeen || turn];
    let actrSum = 0;
    for (const t of mentions) {
      const lag = Math.max(1, (turn - t) * decayMul);
      actrSum += Math.pow(lag, -ACTR_DECAY);
    }

    // Сальность: importance × kindWeight → half-life factor.
    const salience = (it.importance || 1) * (KIND_SALIENCE[it.kind] ?? 1);
    // Нормализация: используем all-at-lag=1 как теоретический максимум для
    // фиксированного числа упоминаний, чтобы items с долгой историей не
    // наказывались большим знаменателем.
    const refContrib = Math.pow(1, -ACTR_DECAY); // = 1.0 при d=0.5
    const maxSum = mentions.length * refContrib;
    const norm = maxSum > 0 ? Math.min(1, actrSum / maxSum) * salience / 3 : 0;
    it.weight = norm * ceilingOf(it);
    it.lastSeen = turn;
  }

  // 2) Выпадение ниже пола — кроме констант. Также выпадают expired цели (weight=0).
  const floor = (s.dropThreshold ?? DROP_FLOOR) * (ceilingOf({ importance: 1 }) || 5) / 5;
  const kept = buf.filter((it) => isConstant(it) || it.weight > floor);
  buf.length = 0; buf.push(...kept);

  // 3) Асимптотическое обогащение: упомянуто в свежих соо → тянем к потолку.
  const recent = new Set((ctx().chat ?? []).slice(-2).flatMap((m) => contentTokens(m.mes)));
  if (recent.size) {
    for (const it of buf) {
      const subjHit = it.subject && recent.has(it.subject);
      const wordHit = contentTokens(it.text).some((w) => recent.has(w));
      if (subjHit || wordHit) {
        const ceil = ceilingOf(it);
        it.weight = ceil - (ceil - it.weight) * REINFORCE_BETA;  // к ceil, не за него
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
  // Константы приоритетны (пин-ярус), но и ОНИ ограничены лимитом — иначе при числе
  // констант ≥ maxItems буфер раздувался бы без потолка. Держим топ-по-весу константы,
  // затем добиваем обычными до maxItems. Жёсткая гарантия: buf.length ≤ maxItems.
  const byWeight = (a, b) => (b.weight - a.weight) || (b.lastSeen - a.lastSeen);
  const consts = buf.filter(isConstant).sort(byWeight).slice(0, s.maxItems);
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
 * Ручная правка пункта буфера из UI. Текст обязателен; kind/importance — опц.
 * Субъект пересчитываем по новому тексту (если явный не передан). Вес НЕ трогаем
 * (правка формулировки не должна ни ронять, ни задирать актуальность). Возвращает
 * true, если что-то изменилось.
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
      it.weight = Math.min(it.weight, ceilingOf(it)); // не выше нового потолка
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
