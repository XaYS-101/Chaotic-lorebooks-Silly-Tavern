// memory-engine.js — Stage-1 «движок памяти» конвейера §4b.
//
// Дешёвая модель читает широко → отдаёт дорогой (= нативной генерации ST) только
// ДИСТИЛЛЯТ. Здесь живёт СБОРКА ядра памяти (огрызки + подграф + ретрив/scout) —
// ровно то, что раньше собирал injector.js inline, — но теперь:
//   • кэшируется по сцене: на статичной сцене НЕ пересобираем ядро, переиспользуем
//     прошлое (injector обновляет лишь локальные 🟢: буфер/избранное);
//   • опционально проходит ОДИН дешёвый Compose/Compress-вызов (call 2 из §4b):
//     сжать до бюджета, voiceQuotes ДОСЛОВНО, снять явные противоречия.
//
// Деградация встроена: LLM=null → сырое код-ядро; pipeline выкл → ведём себя как
// v0.9.0 (всегда свежая сборка, без кэша и без compose). Финальный потолок всё
// равно ставит context-budget.fitBudget в injector — это движок не отменяет.
//
// Метки: каркас ядра 🟢; Compose-проход 🟡 с откатом.

import { getSettings } from './settings.js';
import { renderToc } from './tree-store.js';
import { retrieveWithReason, updateBufferFromScene } from './agents.js';
import { renderForInjection as renderRecollection } from './recollection.js';
import { loadGraph, neighborhood, serializeSubgraph } from './knowledge-graph.js';
import { entitiesInWindow } from './entity-extract.js';
import { agentRequest } from './llm-service.js';

// Кэш ядра прошлой сборки. Сбрасывается на смене чата и запечатывании арки
// (см. index.js), иначе переживёт статичную сцену и переиспользуется.
let cache = null; // { blocks: [{tier,text,priority}] } | null

/** Сбросить кэш ядра (новый чат / новая запечатанная арка → ядро устарело). */
export function resetCache() {
  cache = null;
}

/**
 * Собрать ЯДРО памяти Stage-1 (огрызки + подграф + ретрив).
 * @param {object} o
 * @param {{wake:boolean, shift:boolean}} o.det  результат scene-detector.evaluate()
 * @param {number} o.target                       целевой бюджет токенов всей памяти
 * @param {boolean} o.useCache                    кэшировать ядро по сцене (pipeline.enabled)
 * @param {boolean} o.useComposeLLM               прогнать дешёвый Compose-проход (pipeline.composeLLM)
 * @returns {Promise<{blocks: Array, fromCache: boolean}>}
 */
export async function buildCore({ det, target, useCache, useComposeLLM }) {
  const s = getSettings();

  // 1) КЭШ-ХИТ: статичная сцена + есть прошлое ядро → переиспользуем (главная
  //    экономия §4b: без scout/Compose, без BFS по графу на каждом ходу).
  if (useCache && !det.wake && cache?.blocks) {
    return { blocks: cache.blocks, fromCache: true };
  }

  // 2) GATHER (свежая сборка ядра). Та же логика/приоритеты, что injector.js до §4b.
  const blocks = [];
  const push = (tier, text, priority) => { if (text) blocks.push({ tier, text, priority }); };

  // 2c) ЯРУС 2 — воспоминания (огрызки запечатанных арок). БЕЗ LLM (🟢).
  if (s.recollection?.enabled !== false) {
    const rec = await renderRecollection(s.recollection?.budget).catch(() => '');
    push('recollection', rec, 60);
  }

  // 2d) ЯРУС 3 — подграф вокруг сущностей сцены (эго-граф). БЕЗ LLM на инъекции (🟢):
  //     только BFS по уже смёрженному графу + сериализация компактных триплетов.
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

  // 3) ретрив: будим scout ТОЛЬКО на сдвиге сцены/по cap (не по жёсткому модулю)
  const useAgent = s.retrievalMode === 'agent' && det.wake;
  if (useAgent) {
    const retrieved = await retrieveWithReason();   // 🟡
    if (retrieved) push('toc', retrieved, 70);
    else push('toc', await renderToc(), 70);
    updateBufferFromScene().catch(() => {});
  } else {
    push('toc', await renderToc(), 70);             // дешёвый путь 🟢
  }

  // 4) COMPOSE/COMPRESS (call 2 §4b, опц.) — ОДИН дешёвый проход дистилляции.
  //    Только при сдвиге сцены (на статике переиспользуем кэш) и агентном режиме.
  if (useComposeLLM && useAgent && blocks.length) {
    const distilled = await composeBundle(blocks, target).catch(() => null);
    if (distilled) {
      // Заменяем сырое ядро ОДНИМ дистиллятом (приоритет ретрива — держим в бюджете).
      const composed = [{ tier: 'core', text: distilled, priority: 65 }];
      if (useCache) cache = { blocks: composed };
      return { blocks: composed, fromCache: false };
    }
    // distilled=null → деградация: оставляем сырые блоки ниже.
  }

  if (useCache) cache = { blocks };
  return { blocks, fromCache: false };
}

/**
 * Дешёвый Compose/Compress-проход: сжать собранное ядро до бюджета, voiceQuotes
 * ДОСЛОВНО, снять только ЯВНЫЕ противоречия. Возврат: текст или null (откат).
 */
async function composeBundle(blocks, target) {
  const gathered = blocks.map((b) => b.text).join('\n\n');
  if (!gathered.trim()) return null;
  const limit = Math.max(500, Math.round((target ?? 3000) * 0.8)); // ядро ≈ доля общего бюджета
  const system = 'You compress a roleplay MEMORY bundle for a writer model. '
    + `Keep it under ~${limit} tokens. `
    + 'Keep any quoted lines ("...") VERBATIM — they preserve the character\'s voice. '
    + 'Drop redundancy. Resolve ONLY explicit contradictions, keeping the most recent fact. '
    + 'Do NOT invent anything. Output ONLY the compressed memory text, no commentary.';
  const prompt = `Memory to compress:\n${gathered}\n\nTarget: ~${limit} tokens.`;
  const text = await agentRequest({ system, prompt });
  return text && text.trim() ? text.trim() : null;
}
