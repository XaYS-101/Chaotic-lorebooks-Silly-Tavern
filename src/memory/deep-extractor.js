// deep-extractor.js — глубокое извлечение поверх arc-summary (Фаза C).
// Три задачи (SPEC §7 Фаза C, §0.4 «код-префильтр → дешёвая ИИ только на спорное»):
//   1) АНТИ-ГАЛЛЮЦИНАЦИЯ: строгий allow-list — триплет входит в граф ТОЛЬКО если
//      обе сущности реально есть в сцене ИЛИ уже узлы графа. Выдуманные сущности
//      не плодят узлы (граф растёт по числу СУЩНОСТЕЙ — не должен раздуваться мусором).
//   2) ЗНАЧИМОСТЬ арки 0..1 (чистый код, синхронно): важные арки → авто-пин и
//      приоритет в recollection; «филлер» → быстрее гаснет. scoreSignificance()
//      зовёт arc-summary ДО записи (чтобы влияло на tier/огрызок в нужный момент).
//   3) ДРЕЙФ: дешёвый флаг на арку (drift-monitor) — противоречие установленному
//      ребру. Только флаг, НИКОГДА не авто-удаление (юзер решает в UI).
//
// extractArc() — обработчик job 'deep-extract' (autonomous): allow-list → дрейф →
// graph-merge отфильтрованных триплетов. Полностью защищён: любой сбой → фолбэк на
// прямой graph-merge сырых триплетов (данные не теряем).
//
// Метки: 🟢 значимость/allow-list (код) · 🟡 дрейф (опц. LLM, через drift-monitor).

import { getSettings } from '../core/settings.js';
import { loadGraph } from './knowledge-graph.js';
import { extractEntities, entityKey } from './entity-extract.js';
import { stem } from './text-relevance.js';
import { enqueue } from '../core/job-queue.js';
import { checkDriftCheap } from './drift-monitor.js';
import { log as logActivity } from './activity-log.js';

const DRIFT_KEY = 'chaoticLorebooks_drift';
const DRIFT_CAP = 50;

function ctx() { return SillyTavern.getContext(); }

// --- Значимость (чистый код, синхронно) ---

// Сильные отношения — арка, меняющая их, почти всегда значима.
const STRONG_REL = new Set(['love', 'hat', 'betray', 'kill', 'die', 'death', 'marry',
  'vow', 'owe', 'alli', 'enemi', 'trust', 'fear', 'leav', 'save', 'lose', 'reveal',
  'promis'].map((w) => stem(w)));

function hasStrongRelation(triples) {
  for (const t of triples || []) {
    const rs = stem(String(t?.rel || '').toLowerCase());
    if (!rs) continue;
    for (const s of STRONG_REL) if (rs.includes(s) || s.includes(rs)) return true;
  }
  return false;
}

/**
 * Оценить значимость арки в [0..1] — чистый код, без LLM. Учитывает сильные
 * отношения, число изменений-связей, новые сущности и длину. Триплеты с сущностями
 * вне сцены НЕ учитываем (чтобы галлюцинация не раздувала значимость).
 * @param {{triples:Array, text:string, gist?:string}} input
 * @returns {number}
 */
export function scoreSignificance({ triples = [], text = '', gist = '' } = {}) {
  const sceneStems = new Set(extractEntities(text).map((e) => e.stem));
  const real = (triples || []).filter((t) => t && t.from && t.to
    && sceneStems.has(entityKey(t.from)) && sceneStems.has(entityKey(t.to)));

  let score = 0.3;                                    // база
  if (hasStrongRelation(real)) score += 0.3;
  score += Math.min(0.2, real.length * 0.05);        // больше связей-изменений
  const newEntities = sceneStems.size;
  score += Math.min(0.2, newEntities * 0.04);        // насыщенность сущностями
  if (String(text).length < 400) score -= 0.2;       // совсем короткая арка — филлер
  if (!real.length && !String(gist).trim()) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

// --- Allow-list (анти-галлюцинация) ---

/** Множество стемов разрешённых сущностей: имена сцены ∪ узлы графа (+алиасы). */
function buildAllowList(text, knownNodes) {
  const allow = new Set();
  for (const e of extractEntities(text, knownNodes)) allow.add(e.stem);
  for (const n of knownNodes || []) {
    allow.add(entityKey(n.name));
    for (const a of n.aliases || []) allow.add(entityKey(a));
  }
  allow.delete('');
  return allow;
}

function inAllow(allow, name) { return allow.has(entityKey(name)); }

// --- Хранилище флагов дрейфа (chatMetadata, свой на чат) ---

function driftStore() {
  const meta = ctx().chatMetadata;
  if (!meta) return [];
  if (!Array.isArray(meta[DRIFT_KEY])) meta[DRIFT_KEY] = [];
  return meta[DRIFT_KEY];
}
async function persist() { try { await ctx().saveMetadata(); } catch { /* no-op */ } }

/** Все флаги дрейфа (для UI). Нерешённые сначала, новые сверху. */
export function getDriftFlags() {
  return driftStore().slice().sort((a, b) =>
    (Number(a.resolved) - Number(b.resolved)) || ((b.addedAt ?? 0) - (a.addedAt ?? 0)));
}

/**
 * Записать пачку флагов дрейфа в общую ленту (для дорогого аудита — Фаза D).
 * Дедуп по flagKey (тот же arcId|kind|from|to|rel не плодим, в т.ч. dismissed),
 * cap хранилища. Возвращает число РЕАЛЬНО добавленных. Единый владелец ленты — здесь.
 * @param {Array<{arcId?,kind,from,to,rel,detail?,source?}>} flags
 * @returns {Promise<number>}
 */
export async function addDriftFlags(flags) {
  if (!Array.isArray(flags) || !flags.length) return 0;
  const arr = driftStore();
  let added = 0;
  for (const f of flags) {
    const rec = addFlag(arr, f);
    if (rec) { if (f.source) arr[arr.length - 1].source = f.source; added++; }
  }
  if (added) { capStore(arr); await persist(); }
  return added;
}

/** Снять флаг (Dismiss в UI). Помечаем resolved (не удаляем → не всплывёт снова). */
export async function resolveDriftFlag(id) {
  const f = driftStore().find((x) => x.id === id);
  if (!f) return false;
  f.resolved = true;
  await persist();
  return true;
}

function flagKey(f) { return `${f.arcId}|${f.kind}|${entityKey(f.from)}|${entityKey(f.to)}|${stem(String(f.rel || '').toLowerCase())}`; }

/** Записать флаг с дедупом: тот же (arcId,kind,from,to,rel) не плодим. */
function addFlag(arr, f) {
  const key = flagKey(f);
  if (arr.some((x) => flagKey(x) === key)) return false;   // уже есть (в т.ч. dismissed)
  arr.push({
    id: `d_${f.arcId ?? 'x'}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    arcId: f.arcId ?? null,
    kind: f.kind,
    from: f.from ?? '', to: f.to ?? '', rel: f.rel ?? '',
    detail: String(f.detail || ''),
    resolved: false,
    addedAt: Date.now(),
  });
  return true;
}

/** Подрезать хранилище: сначала старые решённые, затем старые. */
function capStore(arr) {
  if (arr.length <= DRIFT_CAP) return;
  arr.sort((a, b) => (Number(b.resolved) - Number(a.resolved)) || ((a.addedAt ?? 0) - (b.addedAt ?? 0)));
  arr.splice(0, arr.length - DRIFT_CAP);
}

// --- Главный обработчик job 'deep-extract' ---

/**
 * Глубокое извлечение запечатанной арки. Ставится вместо 'graph-merge', когда
 * deepExtract.enabled. payload = { arcId, triples, text, gist }.
 * @returns {Promise<boolean>}
 */
export async function extractArc(payload) {
  const { arcId, triples, text } = payload || {};
  const s = getSettings();
  try {
    if (!Array.isArray(triples) || !triples.length) return false;
    if (s.graph?.enabled === false) return false;

    const g = await loadGraph();
    const known = Object.values(g.nodes || {});
    const allow = buildAllowList(text, known);

    // 1) allow-list: оставляем только триплеты с РЕАЛЬНЫМИ сущностями.
    const kept = [];
    const drift = driftStore();
    let changed = false;
    let flagged = 0;
    for (const t of triples) {
      const fromOk = inAllow(allow, t.from);
      const toOk = inAllow(allow, t.to);
      if (fromOk && toOk) { kept.push(t); continue; }
      const ghost = [!fromOk ? t.from : null, !toOk ? t.to : null].filter(Boolean).join(', ');
      if (addFlag(drift, { arcId, kind: 'hallucination', from: t.from, to: t.to, rel: t.rel,
        detail: `сущность вне сцены: ${ghost}` })) { changed = true; flagged++; }
    }

    // 2) дрейф: спорные/противоречивые связи среди ОСТАВЛЕННЫХ.
    const suspectPairs = [];
    if (s.drift?.cheapEnabled !== false && kept.length) {
      const mode = s.deepExtract?.llmMode ?? 'hybrid';
      const flags = await checkDriftCheap(kept, g, mode, arcId).catch(() => []);
      for (const f of flags) {
        if (addFlag(drift, f)) { changed = true; flagged++; }
        suspectPairs.push([entityKey(f.from), entityKey(f.to)]);
      }
    }

    if (changed) {
      capStore(drift); await persist();
      logActivity({ kind: 'drift', arcId, detail: `${flagged} flag${flagged === 1 ? '' : 's'}` }).catch(() => {});
    }

    // 3) мёрж очищенных триплетов в граф (suspectPairs → пометит рёбра [?]).
    if (kept.length) await enqueue('graph-merge', { arcId, triples: kept, suspectPairs });
    return true;
  } catch (e) {
    console.warn('[ChaoticLorebooks] extractArc failed, falling back to direct merge:', e);
    try {
      if (Array.isArray(triples) && triples.length && s.graph?.enabled !== false) {
        await enqueue('graph-merge', { arcId, triples });
      }
    } catch { /* очередь недоступна — ничего не делаем */ }
    return false;
  }
}
