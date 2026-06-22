// drift-monitor.js — детект «дрейфа» памяти (Фаза C, частично).
// Дрейф = новый факт ПРОТИВОРЕЧИТ установленному ребру графа (напр. было
// «Ren —trusts→ Sable (8)», стало «Ren —betrays→ Sable»). Не удаляем ничего
// автоматически (железное правило: юзер всегда выигрывает) — только ФЛАГ для
// разбора. Дорогой кросс-арочный аудит (auditExpensive) — заглушка под Фазу D.
//
// Два уровня стоимости (выбирает юзер через deepExtract.llmMode):
//   'code'   — только код: явные антонимы отношений (0 LLM);
//   'hybrid' — код для явных + дешёвая ИИ ТОЛЬКО на спорные пары (как гибрид-мёрж);
//   'full'   — один дешёвый LLM-проход по всем триплетам арки против окрестности.
//
// Метки: 🟢 базово (код), 🟡 hybrid/full. Деградация: LLM=null → код-результат.

import { stem } from './text-relevance.js';
import { entityKey } from './entity-extract.js';
import { getSettings } from './settings.js';
import { log as logActivity } from './activity-log.js';

function relStem(rel) { return stem(String(rel || 'related').toLowerCase()); }

// Явные антонимы отношений (по стему). Симметрично достраиваем ниже.
const OPP_RAW = [
  ['trusts', 'betrays'],
  ['loves', 'hates'],
  ['allied_with', 'enemy_of'],
  ['protects', 'threatens'],
  ['helps', 'harms'],
  ['befriends', 'betrays'],
  ['serves', 'rebels_against'],
  ['frees', 'captures'],
  ['saves', 'kills'],
];
const OPPOSITE = new Map();
for (const [a, b] of OPP_RAW) {
  OPPOSITE.set(relStem(a), relStem(b));
  OPPOSITE.set(relStem(b), relStem(a));
}

// «Негативные» отношения — сигнал спорной пары для hybrid-режима, когда явного
// антонима в карте нет, но смена тона налицо.
const NEGATIVE = new Set(['betrays', 'hates', 'kills', 'harms', 'threatens',
  'abandons', 'deceives', 'fears', 'enemy_of', 'rebels_against', 'captures',
  'attacks', 'distrusts'].map(relStem));

function isOpposite(a, b) { return OPPOSITE.get(a) === b; }
function isNegative(r) { return NEGATIVE.has(r); }

/** Рёбра графа на ту же пару узлов (в любом направлении), активные. */
function pairEdges(graph, fromId, toId) {
  return (graph.edges || []).filter((e) => e.active !== false
    && ((e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)));
}

function mkFlag(arcId, t, exEdge, detail) {
  return {
    arcId,
    kind: 'contradiction',
    from: String(t.from),
    to: String(t.to),
    rel: String(t.rel || 'related'),
    detail: detail || `было «${exEdge.rel}», стало «${t.rel}»`,
  };
}

/**
 * Дешёвый флаг дрейфа на арку. Сравнивает НОВЫЕ (уже отфильтрованные allow-list'ом)
 * триплеты с установленными рёбрами графа.
 * @param {Array<{from,rel,to,weight}>} triples
 * @param {{nodes,edges}} graph
 * @param {'code'|'hybrid'|'full'} [llmMode='hybrid']
 * @param {number|null} [arcId]
 * @returns {Promise<Array<{arcId,kind,from,to,rel,detail}>>}
 */
export async function checkDriftCheap(triples, graph, llmMode = 'hybrid', arcId = null) {
  const flags = [];
  const ambiguous = [];
  if (!Array.isArray(triples) || !triples.length || !graph) return flags;

  for (const t of triples) {
    if (!t?.from || !t?.to) continue;
    const fromId = entityKey(t.from);
    const toId = entityKey(t.to);
    if (!fromId || !toId) continue;
    const newRel = relStem(t.rel);
    for (const e of pairEdges(graph, fromId, toId)) {
      const exRel = relStem(e.rel);
      if (exRel === newRel) continue;                 // то же отношение — не дрейф
      if (isOpposite(exRel, newRel)) {
        flags.push(mkFlag(arcId, t, e));              // явный антоним → флаг без LLM
      } else if (isNegative(newRel) !== isNegative(exRel)) {
        ambiguous.push({ t, e });                     // смена тона → спорно, в hybrid/full
      }
    }
  }

  if (llmMode === 'code') return flags;

  if (llmMode === 'full') {
    const extra = await fullDriftPass(triples, graph, arcId).catch(() => []);
    flags.push(...extra);
    return dedupe(flags);
  }

  // hybrid: дешёвая ИИ судит ТОЛЬКО спорные пары (как гибрид-мёрж графа).
  for (const { t, e } of ambiguous) {
    // eslint-disable-next-line no-await-in-loop
    const verdict = await adjudicate(t, e).catch(() => null);
    if (verdict && verdict.contradiction) {
      flags.push(mkFlag(arcId, t, e, verdict.detail));
    }
  }
  return dedupe(flags);
}

function dedupe(flags) {
  const seen = new Set();
  const out = [];
  for (const f of flags) {
    const k = `${f.from}|${f.to}|${relStem(f.rel)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** Дешёвая ИИ: новый факт ПРОТИВОРЕЧИТ старому или это естественное развитие? */
async function adjudicate(t, exEdge) {
  const { agentRequest, parseJsonLoose } = await import('./llm-service.js');
  const { noteLlmCall } = await import('./job-queue.js');
  const system = 'You audit a roleplay knowledge graph for CONTRADICTIONS. Decide if the '
    + 'NEW relationship fact contradicts the EXISTING one, or is natural character '
    + 'development (evolution is NOT a contradiction). '
    + 'Reply ONLY JSON: {"contradiction": <true|false>, "detail": "<short reason>"}.';
  const prompt = `EXISTING: ${exEdge.from} —${exEdge.rel}→ ${exEdge.to} (weight ${exEdge.weight ?? '?'})\n`
    + `NEW: ${t.from} —${t.rel}→ ${t.to}`;
  noteLlmCall();
  const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
  if (!parsed) return null;
  return { contradiction: parsed.contradiction === true, detail: String(parsed.detail || '') };
}

/** Один дешёвый проход по всей арке против окрестности (режим 'full'). */
async function fullDriftPass(triples, graph, arcId) {
  const { agentRequest, parseJsonLoose } = await import('./llm-service.js');
  const { noteLlmCall } = await import('./job-queue.js');
  const { neighborhood, serializeSubgraph } = await import('./knowledge-graph.js');
  const names = [...new Set(triples.flatMap((t) => [t.from, t.to]).filter(Boolean).map(String))];
  const ids = neighborhood(graph, names, 1);
  const existing = serializeSubgraph(graph, ids, 1200) || '(no established relationships yet)';
  const incoming = triples.map((t) => `${t.from} —${t.rel}→ ${t.to}`).join('\n');
  const system = 'You audit a roleplay knowledge graph. List relationship facts in NEW that '
    + 'CONTRADICT the ESTABLISHED graph (not mere evolution). '
    + 'Reply ONLY JSON: {"contradictions":[{"from":"","to":"","rel":"","detail":""}]}.';
  const prompt = `ESTABLISHED:\n${existing}\n\nNEW:\n${incoming}`;
  noteLlmCall();
  const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
  const arr = Array.isArray(parsed?.contradictions) ? parsed.contradictions : [];
  return arr.filter((c) => c && c.from && c.to).map((c) => ({
    arcId, kind: 'contradiction',
    from: String(c.from), to: String(c.to), rel: String(c.rel || 'related'),
    detail: String(c.detail || 'cross-arc contradiction'),
  }));
}

// ============ Фаза D: дорогой кросс-арочный аудит ============
//
// Дешёвый флаг (checkDriftCheap) смотрит ТОЛЬКО новую арку против графа В МОМЕНТ
// запечатывания. Он слеп к противоречиям, которые видны лишь КРОСС-АРОЧНО:
//   - два активных ребра на ОДНОЙ паре узлов с антонимичными/тон-флип отношениями,
//     добавленные в РАЗНОЕ время (каждое поодиночке прошло дешёвый чек);
//   - рёбра, помеченные suspect (invalidateArc после dirty-арки) и не разобранные;
//   - тон-флипы, отложенные дешёвым проходом как «спорные».
// Аудит идёт по ВСЕМУ графу, находит кандидатов кодом, затем ОДИН LLM-проход
// судит, что реально противоречие, а что — естественное развитие. Деградация:
// нет LLM / не autonomous → только структурно достоверные (явные антонимы + suspect).
// НИКОГДА не удаляет — только флаги (в общую ленту дрейфа) + пометка рёбер [?].

const AUDIT_COUNT_KEY = 'chaoticLorebooks_auditCount';

function ctx() { return SillyTavern.getContext(); }

/** Ключ неупорядоченной пары узлов. */
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

/** Минимальная арка-источник ребра (по provenance) — для локализации флага. */
function sinceArc(e) {
  const ks = Object.keys(e?.provenance || {}).map(Number).filter((n) => !Number.isNaN(n));
  return ks.length ? Math.min(...ks) : null;
}

/** Кандидат-флаг из пары рёбер: «новое» (позже по арке) против «старого». */
function flagFromEdges(eOld, eNew) {
  const a = sinceArc(eOld);
  const b = sinceArc(eNew);
  // «новее» = с большей минимальной аркой-источником (если равны — второе).
  const newer = (b ?? 0) >= (a ?? 0) ? eNew : eOld;
  const older = newer === eNew ? eOld : eNew;
  return {
    arcId: sinceArc(newer),
    kind: 'contradiction',
    from: String(newer.from), to: String(newer.to), rel: String(newer.rel || 'related'),
    detail: `Аудит: было «${older.rel}», стало «${newer.rel}»`,
    source: 'audit',
  };
}

/**
 * Кросс-арочный аудит графа. Чистая функция (без записи): возвращает флаги,
 * пары-подозреваемые и сводку. `llm:true` → один LLM-проход уточняет кандидатов.
 * @param {{nodes,edges}} graph
 * @param {{llm?:boolean}} [opts]
 * @returns {Promise<{flags:Array, suspectPairs:Array<[string,string]>, summary:string}>}
 */
export async function auditExpensive(graph, { llm = false } = {}) {
  const empty = { flags: [], suspectPairs: [], summary: 'clean' };
  if (!graph || !Array.isArray(graph.edges) || !graph.edges.length) return empty;

  const active = graph.edges.filter((e) => e.active !== false);

  // Группируем активные рёбра по неупорядоченной паре узлов.
  const byPair = new Map();
  for (const e of active) {
    if (!e.from || !e.to || e.from === e.to) continue;
    const k = pairKey(e.from, e.to);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(e);
  }

  const certain = [];     // (a) явные антонимы + (c) suspect — структурно достоверно
  const ambiguous = [];   // (b) тон-флип — спорно, судит LLM

  for (const edges of byPair.values()) {
    // (c) одиночные suspect-рёбра — переразбор (вес мог быть завышен).
    for (const e of edges) {
      if (e.suspect === true) {
        certain.push({
          arcId: sinceArc(e), kind: 'contradiction',
          from: String(e.from), to: String(e.to), rel: String(e.rel || 'related'),
          detail: `Аудит: подозрительная связь «${e.rel}» (помечена ранее)`, source: 'audit',
        });
      }
    }
    // пары рёбер на одной паре узлов — антонимы / тон-флип.
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const r1 = relStem(edges[i].rel);
        const r2 = relStem(edges[j].rel);
        if (r1 === r2) continue;
        if (isOpposite(r1, r2)) certain.push(flagFromEdges(edges[i], edges[j]));
        else if (isNegative(r1) !== isNegative(r2)) ambiguous.push({ e1: edges[i], e2: edges[j] });
      }
    }
  }

  // Деградация: без LLM возвращаем только структурно достоверное.
  if (!llm) {
    const flags = dedupe(certain);
    return { flags, suspectPairs: flags.map((f) => [entityKey(f.from), entityKey(f.to)]),
      summary: summarize(flags) };
  }

  // ОДИН LLM-проход судит спорные тон-флипы (дорогой профиль, через job-queue/budget).
  let judged = [];
  if (ambiguous.length) {
    judged = await auditPass(graph, ambiguous).catch(() => []);
  }
  const flags = dedupe([...certain, ...judged]);
  return { flags, suspectPairs: flags.map((f) => [entityKey(f.from), entityKey(f.to)]),
    summary: summarize(flags) };
}

function summarize(flags) {
  return flags.length ? `${flags.length} cross-arc contradiction${flags.length === 1 ? '' : 's'}` : 'clean';
}

/** Один дешёвый проход по всем спорным парам графа (тон-флипы). */
async function auditPass(graph, ambiguous) {
  const { agentRequest, parseJsonLoose } = await import('./llm-service.js');
  const { noteLlmCall } = await import('./job-queue.js');
  const name = (id) => graph.nodes?.[id]?.name || id;
  const lines = ambiguous.map(({ e1, e2 }, i) =>
    `${i}: ${name(e1.from)} —${e1.rel}→ ${name(e1.to)}  VS  ${name(e2.from)} —${e2.rel}→ ${name(e2.to)}`).join('\n');
  const system = 'You audit a roleplay knowledge graph for CROSS-ARC CONTRADICTIONS. Each line '
    + 'lists two established relationship facts about the same pair of characters. Decide which '
    + 'pairs are genuine CONTRADICTIONS (not natural character development — evolution is NOT a '
    + 'contradiction). Reply ONLY JSON: {"contradictions":[{"index":<int>,"detail":"<short reason>"}]}.';
  const prompt = `PAIRS:\n${lines}`;
  noteLlmCall();
  const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
  const arr = Array.isArray(parsed?.contradictions) ? parsed.contradictions : [];
  const out = [];
  for (const c of arr) {
    const pair = ambiguous[Number(c?.index)];
    if (!pair) continue;
    const f = flagFromEdges(pair.e1, pair.e2);
    if (c.detail) f.detail = `Аудит: ${String(c.detail)}`;
    out.push(f);
  }
  return out;
}

/**
 * Полный прогон аудита: загрузить граф → найти противоречия → записать флаги в
 * общую ленту дрейфа + пометить рёбра suspect → сбросить счётчик. Динамические
 * импорты избегают статического цикла с deep-extractor (который импортит нас).
 * @param {{paidAllowed?:boolean}} [opts] paidAllowed → разрешён ОДИН LLM-проход
 * @returns {Promise<{added:number, summary:string}>}
 */
export async function runAudit({ paidAllowed = false } = {}) {
  try {
    const { loadGraph } = await import('./knowledge-graph.js');
    const mode = getSettings().deepExtract?.llmMode ?? 'hybrid';
    const graph = await loadGraph();
    const { flags, suspectPairs, summary } = await auditExpensive(graph, { llm: paidAllowed && mode !== 'code' });

    let added = 0;
    if (flags.length) {
      const { addDriftFlags } = await import('./deep-extractor.js');
      added = await addDriftFlags(flags);
      const { markSuspect } = await import('./knowledge-graph.js');
      await markSuspect(suspectPairs).catch(() => {});
    }
    resetAuditCounter();
    logActivity({ kind: 'audit', detail: added ? `${added} new flag${added === 1 ? '' : 's'} · ${summary}` : `clean · ${summary}` })
      .catch(() => {});
    return { added, summary };
  } catch (e) {
    console.warn('[ChaoticLorebooks] runAudit failed:', e);
    return { added: 0, summary: 'audit failed' };
  }
}

// --- Счётчик «раз в ~N устоявшихся ходов» (persisted в метаданные чата) ---

/**
 * Отметить устоявшийся ход. Возвращает true (и сбрасывает счётчик), когда пора
 * запускать дорогой аудит (count ≥ drift.auditEveryNMessages).
 */
export function noteSettledForAudit() {
  const meta = ctx().chatMetadata;
  if (!meta) return false;
  const every = Math.max(1, getSettings().drift?.auditEveryNMessages ?? 500);
  const n = (Number(meta[AUDIT_COUNT_KEY]) || 0) + 1;
  if (n >= every) { meta[AUDIT_COUNT_KEY] = 0; persistMeta(); return true; }
  meta[AUDIT_COUNT_KEY] = n;
  persistMeta();
  return false;
}

/** Сбросить счётчик аудита (после прогона). */
export function resetAuditCounter() {
  const meta = ctx().chatMetadata;
  if (meta) { meta[AUDIT_COUNT_KEY] = 0; persistMeta(); }
}

function persistMeta() { try { ctx().saveMetadata(); } catch { /* no-op */ } }
