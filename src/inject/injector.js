// injector.js — assembles the final Chaotic Lorebooks context block and injects
// it before generation. Called from the global generate_interceptor.
//
// Injection contents (descending priority):
//   1. Thought buffer (OOC mental state)        — 🟢
//   2. ★ Emphasize (favorites)                  — 🟢
//   3. Branch retrieval + scout reasoning (🟡)  — if retrievalMode='agent'
//      else cheap fallback: ToC only (🟢)
//
// Markers: injection scaffold 🟢; scout branch 🟡 with fallback.

import { getSettings } from '../core/settings.js';
import { renderForInjection as renderBuffer } from '../memory/thought-buffer.js';
import { renderForInjection as renderFavs, getRelevantInjection, pickResurfaceText } from './favorites.js';
import { tickBuffer, applyScenePenalty } from '../memory/thought-buffer.js';
import { evaluate as evalScene } from '../memory/scene-detector.js';
import { maintain as autoHideMaintain } from '../memory/auto-hide.js';
import { buildCore } from '../memory/memory-engine.js';
import { fitBudget, setLastReport } from '../memory/context-budget.js';

const INJECT_KEY = 'chaoticLorebooks';
let lastText = '';   // cache of the last build — reused on swipes
let lastMem = '';

// ⚠FLAG: verify the generation-type strings against ST.
const QUIET_TYPES = ['quiet'];                          // our own agent calls — leave alone
const REUSE_TYPES = ['swipe', 'regenerate', 'continue', 'impersonate']; // same scene → cache

/**
 * Main assembly + injection. Called by the interceptor BEFORE generation.
 * @param {string} [genType] generation type (normal|swipe|regenerate|continue|quiet|...)
 */
export async function injectContext(genType) {
  const s = getSettings();
  if (!s.enabled) return;
  const ctx = SillyTavern.getContext();

  // Don't run on our own quiet calls (else recursion + context corruption).
  if (genType && QUIET_TYPES.includes(genType)) return;

  // Swipe/regenerate of the same reply = same scene. Don't run the cheap AI or
  // decay the buffer again — just re-inject the previous build from cache.
  if (genType && REUSE_TYPES.includes(genType)) {
    applyInjection(ctx, s, lastText, lastMem);
    return;
  }

  // Keep the active window: hide matured slabs BEFORE building the prompt (🟢, cheap).
  // The is_system flag removes hidden ones from coreChat — the model won't see them.
  await autoHideMaintain().catch((e) => console.warn('[ChaoticLorebooks] autoHide:', e));

  const blocks = [];
  // Tag each block with tier+priority — context-budget drops the lowest first.
  const push = (tier, text, priority) => { if (text) blocks.push({ tier, text, priority }); };

  // Scene-shift estimate (🟢, no LLM) — drives buffer penalty and agent wake-up.
  const det = evalScene();

  // 1) buffer: decay+enrich once per turn; on a shift — penalty for transients
  await tickBuffer();
  if (det.shift) await applyScenePenalty();
  const buf = renderBuffer();
  push('buffer', buf, 100);

  // 2) favorites (permanent → emphasis; relevant → BM25)
  if (s.favorites.enabled) {
    push('favorites', renderFavs(s.favorites.maxInContext), 90);
    push('favorites', getRelevantInjection(), 80);
  }

  // 2b) resurfacing (BM25 pick) — separate block, depth 3-4
  let memBlock = '';
  if (s.resurfacing?.enabled && Math.random() < (s.resurfacing.chance ?? 0.15)) {
    const mem = pickResurfaceText();
    if (mem) memBlock = `[A memory resurfaces unbidden]\n${mem}`;
  }

  // Memory CORE (gists + subgraph + retrieval/scout) — Stage-1 of engine §4b.
  //   pipeline off → buildCore always builds fresh, no cache/compose = like v0.9.0;
  //   pipeline on → core is cached per scene and (opt.) distilled by a cheap pass.
  const target = s.contextBudget?.target ?? 3000;
  const core = await buildCore({
    det,
    target,
    useCache: !!s.pipeline?.enabled,
    useComposeLLM: !!s.pipeline?.composeLLM,
  });
  for (const b of core.blocks) push(b.tier, b.text, b.priority);

  // Global ceiling (Phase D): one target over all memory, filled by priority.
  // Off → behave like v0.7.0 (plain concatenation, no ceiling).
  if (s.contextBudget?.enabled) {
    const { text } = await fitBudget(blocks, target, memBlock);
    lastText = text;
  } else {
    setLastReport(null);
    lastText = blocks.map((b) => b.text).join('\n\n');
  }
  lastMem = memBlock;
  applyInjection(ctx, s, lastText, lastMem);
}

/** Apply the injection (shared path for fresh build and cache on swipes). */
function applyInjection(ctx, s, text, memBlock) {
  // ⚠️ FLAG: verify the injection method against ST sources:
  //   ctx.setExtensionPrompt(key, value, position, depth, scan, role)
  try {
    if (!ctx.setExtensionPrompt) return;
    // Checked against ST: IN_PROMPT=0, IN_CHAT=1, BEFORE_PROMPT=2.
    const pos = ctx.extension_prompt_types?.IN_PROMPT ?? 0;
    ctx.setExtensionPrompt(INJECT_KEY, text, pos, 1, false);
    const depth = Math.max(1, s.resurfacing?.depth ?? 4);
    ctx.setExtensionPrompt(`${INJECT_KEY}_mem`, memBlock, ctx.extension_prompt_types?.IN_CHAT ?? pos, depth, false);
  } catch (e) {
    console.warn('[ChaoticLorebooks] setExtensionPrompt failed (flagged):', e);
  }
}
