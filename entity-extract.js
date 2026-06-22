// entity-extract.js — выделение СУЩНОСТЕЙ из текста (Фаза B).
// Назначение двоякое:
//   1) дать `arc-summary`/scout alias-aware список сущностей активного окна —
//      чтобы строить эго-граф (окрестность вокруг них), а не тащить весь граф;
//   2) служить allow-list'ом против галлюцинаций для извлечения фактов.
//
// Код-путь (🟢, без LLM): имена собственные (заглавная буква, юникод) + матч по
// известным узлам графа и их алиасам. Этого хватает для эго-графа и инъекции.
// Опциональный 🟡-путь (только при autonomous.enabled) уточняет тип сущности —
// но НИКОГДА не на критическом пути и с деградацией в код-результат.
//
// Метки: 🟢 базово, 🟡 опционально. Деградация встроена.

import { getSettings } from './settings.js';
import { contentTokens, stem } from './text-relevance.js';

function ctx() { return SillyTavern.getContext(); }
function chat() { return ctx().chat ?? []; }

// Имя собственное: слово с заглавной (лат/кир), ≥3 букв. Те же правила, что в
// lorebook-writer.deriveKeys — единый «вид» ключей по всему расширению.
const PROPER_RE = /\b([A-ZА-ЯЁ][\p{L}]{2,})\b/gu;

// Слова, которые часто стоят с заглавной, но сущностями не являются (шум начала
// предложения и обращения). Сравниваем по стему, чтобы покрыть падежи.
const NOISE = new Set(['The', 'You', 'And', 'But', 'She', 'His', 'Her', 'They',
  'Что', 'Как', 'Это', 'Так', 'Вот', 'Они', 'Она'].map((w) => stem(w.toLowerCase())));

/**
 * Выделить сущности из текста.
 * @param {string} text
 * @param {Array<{id,name,type,aliases?}>} [knownNodes] узлы графа для alias-матча
 * @returns {Array<{name, type, count, stem}>}
 */
export function extractEntities(text, knownNodes = []) {
  const src = String(text || '');
  if (!src) return [];

  // Индекс известных узлов по стему имени и алиасов (alias-aware матч).
  const known = new Map();   // stem → {name, type}
  for (const n of knownNodes) {
    for (const label of [n.name, ...(n.aliases || [])]) {
      const st = stem(String(label || '').toLowerCase());
      if (st) known.set(st, { name: n.name, type: n.type });
    }
  }

  const hits = new Map();    // stem → {name, type, count}
  for (const m of src.matchAll(PROPER_RE)) {
    const surface = m[1];
    const st = stem(surface.toLowerCase());
    if (!st || NOISE.has(st)) continue;

    const k = known.get(st);
    const name = k?.name ?? surface;
    const type = k?.type ?? 'unknown';
    const prev = hits.get(st);
    if (prev) { prev.count++; if (k && prev.type === 'unknown') prev.type = type; }
    else hits.set(st, { name, type, count: 1, stem: st });
  }
  return [...hits.values()].sort((a, b) => b.count - a.count);
}

/**
 * Сущности активного окна (последние n устоявшихся соо) — для эго-графа и инъекции.
 * @param {number} [n=6]
 * @param {Array} [knownNodes]
 * @returns {string[]} имена сущностей по убыванию частоты
 */
export function entitiesInWindow(n = 6, knownNodes = []) {
  const c = chat();
  if (!c.length) return [];
  const slice = c.slice(-Math.max(1, n));
  const text = slice.map((m) => `${m?.name ?? ''}: ${m?.mes ?? ''}`).join('\n');
  return extractEntities(text, knownNodes).map((e) => e.name);
}

/**
 * Уточнить ТИПЫ сущностей дешёвой ИИ (опц.). Возвращает обновлённый список или
 * исходный при деградации. Зовётся только из фоновых джоб (autonomous), не в инъекции.
 * @param {Array<{name,type}>} entities
 * @param {string} contextText фрагмент сцены для контекста
 */
export async function classifyTypes(entities, contextText = '') {
  const s = getSettings();
  if (!s.autonomous?.enabled || !entities.length) return entities;
  // Уже всё типизировано известными узлами — LLM не нужен.
  if (entities.every((e) => e.type && e.type !== 'unknown')) return entities;

  try {
    const { agentRequest, parseJsonLoose } = await import('./llm-service.js');
    const { noteLlmCall } = await import('./job-queue.js');
    const names = entities.map((e) => e.name);
    const system = 'Classify each entity by type for a roleplay knowledge graph. '
      + 'Types: character | location | faction | item. If unsure, use "character" for '
      + 'people-like names, else "item". Reply ONLY JSON: {"types":{"Name":"type",...}}.';
    const prompt = `Entities: ${names.join(', ')}\n\nScene:\n${String(contextText).slice(0, 1200)}`;
    noteLlmCall();
    const parsed = parseJsonLoose(await agentRequest({ system, prompt }));
    const types = parsed?.types;
    if (!types || typeof types !== 'object') return entities;
    return entities.map((e) => ({ ...e, type: types[e.name] || e.type || 'unknown' }));
  } catch (err) {
    console.warn('[ChaoticLorebooks] classifyTypes degraded:', err);
    return entities;
  }
}

/** Стем имени — общий помощник для дедупа сущностей по падежам. */
export function entityKey(name) { return stem(String(name || '').toLowerCase()); }

/** Контент-токены имени (для трайграм/префильтра в графе). */
export function nameTokens(name) { return contentTokens(name); }
