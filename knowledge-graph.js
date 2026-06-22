// knowledge-graph.js — ярус 3: граф сущностей и связей (Фаза B).
// Хранится как ОДНА manifest-энтри в привязанной книге (JSON), disable:true —
// никогда не активируется keyword-сканом (сырой JSON в промпт не попадает), но
// переживает экспорт/импорт книги и едет вместе с ней.
//
// Железное правило #4: граф МЕРЖИТСЯ, не пересобирается. Дедуп — ГИБРИД:
//   1) код-префильтр (стем имени + пара узлов) сужает до соседей-кандидатов;
//   2) дешёвая ИИ решает update|create на этом МАЛОМ наборе (семантика:
//      «Рен доверяет Сейбл» == «Сейбл заслужила доверие Рена»);
//   3) код применяет идемпотентно; provenance {arcId:вклад} хранит вклад каждой
//      арки — для отката (invalidateArc) без перезапуска нижележащих арок.
// Тип-гард: узлы разных типов (character/location) НЕ сливаются.
//
// Всё тяжёлое (LLM-мёрж) идёт из job-queue, вне критического пути. Чтение для
// инъекции (neighborhood/serialize) — чистый код, БЕЗ LLM.
//
// Метки: 🟡 мёрж · 🟢 чтение. Деградация: нет LLM → код-дедуп по точному совпадению.

import { getSettings } from './settings.js';
import { casWrite, ENTRY_TEMPLATE } from './lorebook-writer.js';
import { getBoundBookName } from './lorebook-service.js';
import { entityKey } from './entity-extract.js';
import { stem } from './text-relevance.js';
import { log as logActivity } from './activity-log.js';

function ctx() { return SillyTavern.getContext(); }

const MANIFEST_KEY = '__cl_graph__';
const MANIFEST_RE = /tier=manifest/i;

const EMPTY = () => ({ nodes: {}, edges: [] });

// --- Поиск/создание manifest-энтри в книге ---
function findManifest(data) {
  for (const e of Object.values(data.entries || {})) {
    if (MANIFEST_RE.test(String(e.comment ?? '')) && (e.key ?? []).includes(MANIFEST_KEY)) return e;
  }
  return null;
}

/** Прочитать граф из книги. Возвращает {nodes,edges} (пустой при отсутствии). */
export async function loadGraph() {
  const book = getBoundBookName();
  if (!book) return EMPTY();
  let data;
  try { data = await ctx().loadWorldInfo(book); } catch { return EMPTY(); }
  const ent = data && findManifest(data);
  if (!ent) return EMPTY();
  try {
    const g = JSON.parse(ent.content || '{}');
    return { nodes: g.nodes || {}, edges: Array.isArray(g.edges) ? g.edges : [] };
  } catch { return EMPTY(); }
}

/** Записать граф в manifest-энтри (под мьютексом writer'а, через casWrite). */
async function saveGraph(g) {
  return casWrite(null, async (data) => {
    let ent = findManifest(data);
    const content = JSON.stringify({ nodes: g.nodes, edges: g.edges });
    if (!ent) {
      // создаём новую ОТКЛЮЧЁННУЮ энтри-контейнер (полный шаблон WI-записи)
      let uid = 0; while (uid in data.entries) uid++;
      data.entries[uid] = {
        ...structuredClone(ENTRY_TEMPLATE), uid,
        key: [MANIFEST_KEY], content,
        comment: '[CL origin=graph tier=manifest]',
        disable: true,        // никогда не активируется keyword-сканом
      };
    } else {
      if (ent.content === content) return false;     // без изменений — не пишем
      ent.content = content;
      ent.disable = true;                            // граф не должен инжектиться как есть
    }
    return true;
  });
}

// --- Узлы ---
function nodeId(name) { return entityKey(name); }

function upsertNode(g, name, type, arcId) {
  const id = nodeId(name);
  if (!id) return null;
  const cur = g.nodes[id];
  if (cur) {
    if ((!cur.type || cur.type === 'unknown') && type && type !== 'unknown') cur.type = type;
    // запомним поверхностную форму как алиас (для alias-aware матча сцены)
    if (name && cur.name !== name && !(cur.aliases || []).includes(name)) {
      cur.aliases = [...(cur.aliases || []), name].slice(0, 6);
    }
    cur.lastActive = Math.max(cur.lastActive ?? 0, arcId ?? 0);
    cur.archived = false;
    return id;
  }
  g.nodes[id] = {
    name, type: type || 'unknown', tier: 3, aliases: [],
    lastActive: arcId ?? 0, archived: false,
  };
  return id;
}

// --- Рёбра ---
function relStem(rel) { return stem(String(rel || 'related').toLowerCase()); }

/** Кандидаты-рёбра для гибрид-мёржа: та же пара узлов в любом направлении. */
function candidateEdges(g, from, to) {
  return g.edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (e.from === from && e.to === to) || (e.from === to && e.to === from));
}

function bumpEdge(edge, weight, arcId) {
  edge.weight = Math.max(1, Math.min(10, (edge.weight ?? 5) + (weight ? 0 : 1)));
  if (weight) edge.weight = Math.max(1, Math.min(10, weight));
  edge.provenance = edge.provenance || {};
  if (arcId != null) edge.provenance[arcId] = (edge.provenance[arcId] || 0) + 1;
  edge.active = true;
  delete edge.suspect;
}

/**
 * Гибрид-мёрж триплетов в граф. Идемпотентно, с provenance по арке.
 * @param {{arcId:number, triples:Array<{from,rel,to,weight,fromType?,toType?}>, suspectPairs?:Array<[string,string]>}} payload
 * `suspectPairs` (от deep-extractor): пары node-id, чьи рёбра помечаем suspect ([?])
 * — дрейф/противоречие, требует разбора. Мечаем ПОСЛЕ мёржа (иначе bumpEdge снимет).
 * Вызывается как обработчик job 'graph-merge'.
 */
export async function addTriples(payload) {
  const { triples, arcId, suspectPairs } = payload || {};
  if (!Array.isArray(triples) || !triples.length) return false;
  const s = getSettings();
  if (s.graph?.enabled === false) return false;

  const g = await loadGraph();
  const nodes0 = Object.keys(g.nodes).length;   // для дельты в ленте активности
  const edges0 = g.edges.length;

  for (const t of triples) {
    if (!t?.from || !t?.to) continue;
    const fromId = upsertNode(g, String(t.from), t.fromType, arcId);
    const toId = upsertNode(g, String(t.to), t.toType, arcId);
    if (!fromId || !toId || fromId === toId) continue;

    const rs = relStem(t.rel);
    const cands = candidateEdges(g, fromId, toId);

    // 1) Точное совпадение направления+отношения → апдейт (без LLM).
    const exact = cands.find(({ e }) => e.from === fromId && e.to === toId && relStem(e.rel) === rs);
    if (exact) { bumpEdge(exact.e, t.weight, arcId); continue; }

    // 2) Гибрид: есть кандидаты (другое отношение/направление) → дешёвая ИИ решает.
    let merged = false;
    if (cands.length && s.autonomous?.enabled) {
      const decision = await decideMerge(t, cands.map(({ e }) => e)).catch(() => null);
      if (decision && decision.matchIndex != null && cands[decision.matchIndex]) {
        const edge = cands[decision.matchIndex].e;
        // тип-гард уже обеспечен парой узлов; принимаем каноническое отношение
        if (decision.rel) edge.rel = decision.rel;
        bumpEdge(edge, t.weight, arcId);
        merged = true;
      }
    }
    if (merged) continue;

    // 3) Новое ребро.
    g.edges.push({
      from: fromId, to: toId, rel: String(t.rel || 'related'),
      weight: Math.max(1, Math.min(10, t.weight || 5)),
      provenance: arcId != null ? { [arcId]: 1 } : {}, active: true,
    });
  }

  // Пометить дрейф-пары suspect (после мёржа, чтобы bumpEdge не снял флаг).
  if (Array.isArray(suspectPairs) && suspectPairs.length) {
    for (const [a, b] of suspectPairs) {
      if (!a || !b) continue;
      for (const e of g.edges) {
        if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) e.suspect = true;
      }
    }
  }

  archiveColdInPlace(g, arcId);
  capNodesInPlace(g);

  const dNodes = Object.keys(g.nodes).length - nodes0;
  const dEdges = g.edges.length - edges0;
  logActivity({ kind: 'graph-merge', arcId, detail: `+${dNodes} node${dNodes === 1 ? '' : 's'}, +${dEdges} edge${dEdges === 1 ? '' : 's'}` })
    .catch(() => {});

  return saveGraph(g);
}

/** Дешёвая ИИ: эквивалентен ли новый триплет одному из кандидатов? */
async function decideMerge(triple, candidates) {
  const { agentRequest, parseJsonLoose } = await import('./llm-service.js');
  const { noteLlmCall } = await import('./job-queue.js');
  const list = candidates.map((e, i) => `${i}: ${e.from} —${e.rel}→ ${e.to}`).join('\n');
  const system = 'You merge relationship facts in a knowledge graph. Decide if the NEW '
    + 'fact expresses the SAME relationship as one of the EXISTING ones (semantic, '
    + 'direction-aware: "A trusts B" == "B earned A\'s trust"). '
    + 'Reply ONLY JSON: {"matchIndex": <int or null>, "rel": "<canonical short relation>"}.';
  const prompt = `NEW: ${triple.from} —${triple.rel}→ ${triple.to}\n\nEXISTING:\n${list}`;
  noteLlmCall();
  const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
  if (!parsed) return null;
  const mi = parsed.matchIndex;
  return { matchIndex: (typeof mi === 'number' && mi >= 0) ? mi : null, rel: parsed.rel };
}

// --- Эго-граф (чтение, БЕЗ LLM) ---
/** Узлы, достижимые из имён сущностей за hops шагов по активным рёбрам. */
export function neighborhood(g, entityNames, hops = 2) {
  const ids = new Set();
  const seed = (entityNames || []).map(nodeId).filter((id) => id && g.nodes[id]);
  let frontier = new Set(seed);
  seed.forEach((id) => ids.add(id));
  for (let h = 0; h < Math.max(1, hops); h++) {
    const next = new Set();
    for (const e of g.edges) {
      if (e.active === false) continue;
      if (frontier.has(e.from) && !ids.has(e.to)) { ids.add(e.to); next.add(e.to); }
      if (frontier.has(e.to) && !ids.has(e.from)) { ids.add(e.from); next.add(e.from); }
    }
    if (!next.size) break;
    frontier = next;
  }
  return ids;
}

/** Сериализовать подграф компактными триплетами под бюджет (🟢, для инъекции). */
export function serializeSubgraph(g, nodeIds, budgetTokens) {
  const idset = nodeIds instanceof Set ? nodeIds : new Set(nodeIds || []);
  if (!idset.size) return '';
  const name = (id) => g.nodes[id]?.name || id;
  const lines = [];
  for (const e of g.edges) {
    if (e.active === false) continue;
    if (!idset.has(e.from) || !idset.has(e.to)) continue;
    if (g.nodes[e.from]?.archived || g.nodes[e.to]?.archived) continue;
    const since = sinceArc(e);
    const w = e.weight != null ? `${e.weight}/10` : '';
    const meta = [w, since != null ? `since arc${since}` : ''].filter(Boolean).join(', ');
    lines.push(`${name(e.from)} —${e.rel}→ ${name(e.to)}${meta ? ` (${meta})` : ''}${e.suspect ? ' [?]' : ''}`);
  }
  if (!lines.length) return '';
  // грубый бюджет: ~4 символа/токен
  const charBudget = Math.max(200, (budgetTokens || 1500) * 4);
  let out = '';
  for (const l of lines) { if (out.length + l.length + 1 > charBudget) break; out += (out ? '\n' : '') + l; }
  return `[Relationship graph — what these characters mean to each other]\n${out}`;
}

function sinceArc(e) {
  const ks = Object.keys(e.provenance || {}).map(Number).filter((n) => !Number.isNaN(n));
  return ks.length ? Math.min(...ks) : null;
}

// --- Инвалидация (откат вклада dirty-арки) ---
/**
 * Вычесть вклад арки. Ребро удаляем ТОЛЬКО если у него не осталось других
 * арок-источников; иначе оставляем (provenance держит другие арки). Каскад
 * ограничен рёбрами, чей единственный источник — эта арка.
 */
export async function invalidateArc(arcId) {
  if (arcId == null) return false;
  const g = await loadGraph();
  let changed = false;
  const kept = [];
  for (const e of g.edges) {
    if (!e.provenance || !(arcId in e.provenance)) { kept.push(e); continue; }
    delete e.provenance[arcId];
    changed = true;
    const remaining = Object.keys(e.provenance).length;
    if (remaining === 0) continue;                 // единственный источник — арка N → удаляем
    // другие арки ещё держат ребро; вес мог быть завышен → помечаем suspect (в аудит)
    e.suspect = true;
    kept.push(e);
  }
  if (!changed) return false;
  g.edges = kept;
  return saveGraph(g);
}

// --- Холодные узлы / потолок ---
function archiveColdInPlace(g, currentArc) {
  const after = getSettings().graph?.archiveColdAfterArcs ?? 8;
  const now = currentArc ?? maxArc(g);
  for (const n of Object.values(g.nodes)) {
    if ((now - (n.lastActive ?? 0)) > after) n.archived = true;
  }
}
function capNodesInPlace(g) {
  const cap = getSettings().graph?.maxNodes ?? 40;
  const live = Object.entries(g.nodes).filter(([, n]) => !n.archived);
  if (live.length <= cap) return;
  // архивируем самые холодные сверх потолка
  live.sort((a, b) => (a[1].lastActive ?? 0) - (b[1].lastActive ?? 0));
  for (let i = 0; i < live.length - cap; i++) g.nodes[live[i][0]].archived = true;
}
function maxArc(g) {
  let m = 0;
  for (const e of g.edges) for (const k of Object.keys(e.provenance || {})) m = Math.max(m, Number(k) || 0);
  return m;
}

/** Архивировать холодные узлы (вызов из обслуживания/джобы). */
export async function archiveCold(currentArc) {
  const g = await loadGraph();
  archiveColdInPlace(g, currentArc);
  capNodesInPlace(g);
  return saveGraph(g);
}

/**
 * Пометить рёбра suspect ([?]) по парам узлов (Фаза D — дорогой аудит). Зеркалит
 * suspectPairs-путь из addTriples, но как самостоятельный писатель. Пары — id узлов
 * в любом направлении. No-op при пустом вводе.
 * @param {Array<[string,string]>} pairs
 * @returns {Promise<boolean>}
 */
export async function markSuspect(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return false;
  const g = await loadGraph();
  let changed = false;
  for (const [a, b] of pairs) {
    if (!a || !b) continue;
    for (const e of g.edges) {
      if (e.active === false) continue;
      if (((e.from === a && e.to === b) || (e.from === b && e.to === a)) && !e.suspect) {
        e.suspect = true; changed = true;
      }
    }
  }
  if (!changed) return false;
  return saveGraph(g);
}

/** Краткая статистика для статус-строки UI (🟢). */
export async function getStats() {
  const g = await loadGraph();
  const nodes = Object.values(g.nodes).filter((n) => !n.archived).length;
  return { nodes, edges: g.edges.filter((e) => e.active !== false).length };
}
