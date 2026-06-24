// memory-engine.js — Stage-1 "memory engine" of the §4b pipeline.
//
// The cheap model reads broadly → hands the expensive model (= ST's native generation)
// only the DISTILLATE. This is where the memory CORE is assembled (gists + subgraph +
// retrieval/scout) — exactly what injector.js used to build inline — but now:
//   • cached per scene: on a static scene the core is NOT rebuilt, the previous one is
//     reused (injector only refreshes the local 🟢 tiers: buffer/favorites);
//   • optionally runs ONE cheap Compose/Compress call (call 2 of §4b): compress to
//     budget, keep voiceQuotes VERBATIM, resolve explicit contradictions.
//
// Degradation built in: LLM=null → raw code core; pipeline off → behaves like v0.9.0
// (always a fresh build, no cache, no compose). The final ceiling is still set by
// context-budget.fitBudget in injector — the engine doesn't replace that.
//
// Markers: core scaffold 🟢; Compose pass 🟡 with fallback.

import { getSettings, backgroundJobsAllowed } from '../core/settings.js';
import { renderToc } from '../lorebook/tree-store.js';
import { retrieveWithReason, updateBufferFromScene } from '../llm/agents.js';
import { getBuffer } from './thought-buffer.js';
import { renderForInjection as renderRecollection } from './recollection.js';
import { loadGraph, neighborhood, serializeSubgraph } from './knowledge-graph.js';
import { entitiesInWindow } from './entity-extract.js';
import { agentRequest } from '../llm/llm-service.js';

// Cache of the last-built core. Cleared on chat switch and arc sealing (see index.js),
// otherwise it survives a static scene and gets reused.
let cache = null; // { blocks: [{tier,text,priority}] } | null

/** Clear the core cache (new chat / newly sealed arc → core is stale). */
export function resetCache() {
  cache = null;
}

/**
 * Build the Stage-1 memory CORE (gists + subgraph + retrieval).
 * @param {object} o
 * @param {{wake:boolean, shift:boolean}} o.det  result of scene-detector.evaluate()
 * @param {number} o.target                       target token budget for all memory
 * @param {boolean} o.useCache                    cache the core per scene (pipeline.enabled)
 * @param {boolean} o.useComposeLLM               run the cheap Compose pass (pipeline.composeLLM)
 * @returns {Promise<{blocks: Array, fromCache: boolean}>}
 */
export async function buildCore({ det, target, useCache, useComposeLLM }) {
  const s = getSettings();

  // 1) CACHE HIT: static scene + a previous core exists → reuse it (the main §4b
  //    saving: no scout/Compose, no graph BFS on every turn).
  if (useCache && !det.wake && cache?.blocks) {
    return { blocks: cache.blocks, fromCache: true };
  }

  // 2) GATHER (fresh core build). Same logic/priorities as injector.js before §4b.
  const blocks = [];
  const push = (tier, text, priority) => { if (text) blocks.push({ tier, text, priority }); };

  // 2c) TIER 2 — recollections (gists of sealed arcs). NO LLM (🟢).
  if (s.recollection?.enabled !== false) {
    const rec = await renderRecollection(s.recollection?.budget).catch(() => '');
    push('recollection', rec, 60);
  }

  // 2d) TIER 3 — subgraph around the scene's entities (ego-graph). NO LLM on injection (🟢):
  //     just BFS over the already-merged graph + serialization of compact triples.
  if (s.graph?.enabled !== false) {
    try {
      const g = await loadGraph();
      if (Object.keys(g.nodes).length) {
        const known = Object.values(g.nodes).map((n) => ({ name: n.name, type: n.type, aliases: n.aliases }));
        const names = entitiesInWindow(6, known);
        const sub = neighborhood(g, names, s.graph?.subgraphHops ?? 2);
        const gblock = serializeSubgraph(g, sub, s.graph?.budget ?? 1500);
        push('graph', gblock, 50);
      }
    } catch (e) { console.warn('[ChaoticLorebooks] graph inject skipped:', e); }
  }

  // 3) retrieval: wake scout ONLY on a scene shift / cap (not on a hard modulo)
  const useAgent = s.retrievalMode === 'agent' && det.wake;
  if (useAgent) {
    const retrieved = await retrieveWithReason();   // 🟡
    if (retrieved) push('toc', retrieved, 70);
    else push('toc', await renderToc(), 70);
  } else {
    push('toc', await renderToc(), 70);             // cheap path 🟢
  }

  // 3b) The thought buffer is not tied to agent retrieval: update in any non-lite mode
  //     on a scene shift, or while the buffer is empty early in the chat (the agent
  //     request falls back to the current connection if no dedicated agent). Fire-and-forget.
  if (s.thoughtBuffer?.enabled && backgroundJobsAllowed(s)) {
    const chatLen = (SillyTavern.getContext().chat ?? []).length;
    if (det.wake || (getBuffer().length === 0 && chatLen >= 2)) {
      updateBufferFromScene().catch(() => {});
    }
  }

  // 4) COMPOSE/COMPRESS (call 2 §4b, optional) — ONE cheap distillation pass.
  //    Only on a scene shift (static scenes reuse the cache) and in agent mode.
  if (useComposeLLM && useAgent && blocks.length) {
    const distilled = await composeBundle(blocks, target).catch(() => null);
    if (distilled) {
      // Replace the raw core with ONE distillate (retrieval priority — keep within budget).
      const composed = [{ tier: 'core', text: distilled, priority: 65 }];
      if (useCache) cache = { blocks: composed };
      return { blocks: composed, fromCache: false };
    }
    // distilled=null → degradation: keep the raw blocks below.
  }

  if (useCache) cache = { blocks };
  return { blocks, fromCache: false };
}

/** Cheap Compose/Compress pass: reduce core to budget, keep quotes verbatim. Returns text or null. */
async function composeBundle(blocks, target) {
  const gathered = blocks.map((b) => b.text).join('\n\n');
  if (!gathered.trim()) return null;
  const limit = Math.max(500, Math.round((target ?? 3000) * 0.8)); // core ≈ share of total budget
  const system = 'You compress a roleplay MEMORY bundle for a writer model. '
    + `Keep it under ~${limit} tokens. `
    + 'Keep any quoted lines ("...") VERBATIM — they preserve the character\'s voice. '
    + 'Drop redundancy. Resolve ONLY explicit contradictions, keeping the most recent fact. '
    + 'Do NOT invent anything. Output ONLY the compressed memory text, no commentary.';
  const prompt = `Memory to compress:\n${gathered}\n\nTarget: ~${limit} tokens.`;
  const text = await agentRequest({ system, prompt });
  return text && text.trim() ? text.trim() : null;
}
