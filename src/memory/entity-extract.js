// entity-extract.js — extract ENTITIES from text (Phase B).
// Dual purpose:
//   1) give arc-summary/scout an alias-aware list of entities in the active window —
//      to build an ego-graph (the neighborhood around them) instead of the whole graph;
//   2) serve as an anti-hallucination allow-list for fact extraction.
//
// Code path (🟢, no LLM): proper nouns (capitalized, Unicode) + match against known
// graph nodes and their aliases. Enough for the ego-graph and injection.
// Optional 🟡 path (only when autonomous.enabled) refines entity type — but NEVER on
// the critical path, and degrades to the code result.
//
// Markers: 🟢 baseline, 🟡 optional. Degradation built in.

import { getSettings } from '../core/settings.js';
import { contentTokens, stem } from './text-relevance.js';

function ctx() { return SillyTavern.getContext(); }
function chat() { return ctx().chat ?? []; }

// Proper noun: a capitalized word (Latin/Cyrillic), ≥3 letters. Same rules as in
// lorebook-writer.deriveKeys — one key "shape" across the whole extension.
const PROPER_RE = /\b([A-ZА-ЯЁ][\p{L}]{2,})\b/gu;

// Words often capitalized but not entities (sentence-start noise and pronouns).
// Compared by stem to cover inflected forms.
const NOISE = new Set(['The', 'You', 'And', 'But', 'She', 'His', 'Her', 'They',
  'Что', 'Как', 'Это', 'Так', 'Вот', 'Они', 'Она'].map((w) => stem(w.toLowerCase())));

/**
 * Extract entities from text.
 * @param {string} text
 * @param {Array<{id,name,type,aliases?}>} [knownNodes] graph nodes for alias matching
 * @returns {Array<{name, type, count, stem}>}
 */
export function extractEntities(text, knownNodes = []) {
  const src = String(text || '');
  if (!src) return [];

  // Index known nodes by the stem of their name and aliases (alias-aware match).
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
 * Entities in the active window (last n settled messages) — for the ego-graph and injection.
 * @param {number} [n=6]
 * @param {Array} [knownNodes]
 * @returns {string[]} entity names, most frequent first
 */
export function entitiesInWindow(n = 6, knownNodes = []) {
  const c = chat();
  if (!c.length) return [];
  const slice = c.slice(-Math.max(1, n));
  const text = slice.map((m) => `${m?.name ?? ''}: ${m?.mes ?? ''}`).join('\n');
  return extractEntities(text, knownNodes).map((e) => e.name);
}

/**
 * Refine entity TYPES with a cheap LLM (optional). Returns the updated list, or the
 * original on degradation. Called only from background jobs (autonomous), never in injection.
 * @param {Array<{name,type}>} entities
 * @param {string} contextText scene fragment for context
 */
export async function classifyTypes(entities, contextText = '') {
  const s = getSettings();
  if (!s.autonomous?.enabled || !entities.length) return entities;
  // Everything already typed via known nodes — no LLM needed.
  if (entities.every((e) => e.type && e.type !== 'unknown')) return entities;

  try {
    const { agentRequest, parseJsonLoose } = await import('../llm/llm-service.js');
    const { noteLlmCall } = await import('../core/job-queue.js');
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

/** Name stem — shared helper for deduping entities across grammatical cases. */
export function entityKey(name) { return stem(String(name || '').toLowerCase()); }

/** Content tokens of a name (for trigram/prefilter in the graph). */
export function nameTokens(name) { return contentTokens(name); }
