// injector.js — собирает финальный контекст-блок Chaotic Lorebooks и вкладывает
// его перед генерацией. Вызывается из глобального generate_interceptor.
//
// Состав инъекции (по убыванию приоритета):
//   1. Буфер мыслей (OOC mental state)        — 🟢
//   2. ★ Emphasize (избранное)                — 🟢
//   3. Ретрив веток + рассуждение scout (🟡)  — если retrievalMode='agent'
//      иначе дешёвый фолбэк: только оглавление (🟢)
//
// Метки: каркас инъекции 🟢; ветка scout 🟡 с откатом.

import { getSettings } from './settings.js';
import { renderForInjection as renderBuffer } from './thought-buffer.js';
import { renderForInjection as renderFavs, getRelevantInjection, pickResurfaceText } from './favorites.js';
import { tickBuffer, applyScenePenalty } from './thought-buffer.js';
import { evaluate as evalScene } from './scene-detector.js';
import { maintain as autoHideMaintain } from './auto-hide.js';
import { buildCore } from './memory-engine.js';
import { fitBudget, setLastReport } from './context-budget.js';

const INJECT_KEY = 'chaoticLorebooks';
let lastText = '';   // кэш последней сборки — переиспользуем на свайпах
let lastMem = '';

// ⚠FLAG: сверить строки типов генерации в ST.
const QUIET_TYPES = ['quiet'];                          // наши же agent-вызовы — НЕ трогаем
const REUSE_TYPES = ['swipe', 'regenerate', 'continue', 'impersonate']; // та же сцена → кэш

/**
 * Главный сбор + инъекция. Зовётся интерсептором ДО генерации.
 * @param {string} [genType] тип генерации (normal|swipe|regenerate|continue|quiet|...)
 */
export async function injectContext(genType) {
  const s = getSettings();
  if (!s.enabled) return;
  const ctx = SillyTavern.getContext();

  // На наших собственных quiet-вызовах НЕ работаем (иначе рекурсия + порча контекста).
  if (genType && QUIET_TYPES.includes(genType)) return;

  // СВАЙП/регенерация той же реплики = та же сцена. Не гоняем дешёвую ИИ и не
  // затухаем буфер повторно — просто переинжектим прошлую сборку из кэша.
  if (genType && REUSE_TYPES.includes(genType)) {
    applyInjection(ctx, s, lastText, lastMem);
    return;
  }

  // Поддержать активное окно: скрыть дозревшие пласты ДО сборки промпта (🟢, дёшево).
  // is_system-флаг убирает скрытое из coreChat — модель его не увидит.
  await autoHideMaintain().catch((e) => console.warn('[ChaoticLorebooks] autoHide:', e));

  const blocks = [];
  // Тегируем каждый блок ярусом+приоритетом — context-budget роняет первыми низшие.
  const push = (tier, text, priority) => { if (text) blocks.push({ tier, text, priority }); };

  // Оценка сдвига сцены (🟢, без LLM) — управляет пенальти буфера и побудкой агента.
  const det = evalScene();

  // 1) буфер: затухание+обогащение раз за ход; при сдвиге — пенальти транзитным
  await tickBuffer();
  if (det.shift) await applyScenePenalty();
  const buf = renderBuffer();
  push('buffer', buf, 100);

  // 2) избранное (permanent → акцент; relevant → BM25)
  if (s.favorites.enabled) {
    push('favorites', renderFavs(s.favorites.maxInContext), 90);
    push('favorites', getRelevantInjection(), 80);
  }

  // 2b) ресёрфинг (BM25-выбор) — отдельный блок, глубина 3-4
  let memBlock = '';
  if (s.resurfacing?.enabled && Math.random() < (s.resurfacing.chance ?? 0.15)) {
    const mem = pickResurfaceText();
    if (mem) memBlock = `[A memory resurfaces unbidden]\n${mem}`;
  }

  // ЯДРО памяти (огрызки + подграф + ретрив/scout) — Stage-1 движка §4b.
  //   pipeline выкл → buildCore всегда собирает свежо, без кэша/compose = как v0.9.0;
  //   pipeline вкл → ядро кэшируется по сцене и (опц.) дистиллируется дешёвым проходом.
  const target = s.contextBudget?.target ?? 3000;
  const core = await buildCore({
    det,
    target,
    useCache: !!s.pipeline?.enabled,
    useComposeLLM: !!s.pipeline?.composeLLM,
  });
  for (const b of core.blocks) push(b.tier, b.text, b.priority);

  // Глобальный потолок (Фаза D): один target на всю память, заполнение по приоритету.
  // Выключен → ведём себя как v0.7.0 (просто склейка, без потолка).
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

/** Применить инъекцию (общий путь для свежей сборки и для кэша на свайпах). */
function applyInjection(ctx, s, text, memBlock) {
  // ⚠️ FLAG: метод инъекции сверить с исходниками ST:
  //   ctx.setExtensionPrompt(key, value, position, depth, scan, role)
  try {
    if (!ctx.setExtensionPrompt) return;
    // Сверено с ST: IN_PROMPT=0, IN_CHAT=1, BEFORE_PROMPT=2.
    const pos = ctx.extension_prompt_types?.IN_PROMPT ?? 0;
    ctx.setExtensionPrompt(INJECT_KEY, text, pos, 1, false);
    const depth = Math.max(1, s.resurfacing?.depth ?? 4);
    ctx.setExtensionPrompt(`${INJECT_KEY}_mem`, memBlock, ctx.extension_prompt_types?.IN_CHAT ?? pos, depth, false);
  } catch (e) {
    console.warn('[ChaoticLorebooks] setExtensionPrompt failed (flagged):', e);
  }
}
