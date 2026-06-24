// arc-summary.js — извлечение из запечатанной арки (Фаза B, 🟡).
// Один проход на арку (железное правило #3 — инкрементальность): дешёвая ИИ
// читает пласт арки и возвращает:
//   - gist        — 1-3 предложения сути арки (для яруса 2);
//   - voiceQuotes — 2-4 ДОСЛОВНЫЕ реплики персонажа (держат стиль);
//   - triples     — связи {from,rel,to,weight} для графа (ярус 3).
// Затем:
//   - кладём gist на арку (arc-segmenter.setSummaryGist);
//   - добавляем огрызок в recollection (ярус 2);
//   - ставим джобу 'graph-merge' (гибрид-мёрж триплетов вне крит. пути);
//   - пишем STANDALONE keyed-энтри арки в книгу (origin=auto-arc) — книга помнит
//     арку по ключевым словам даже с выключенным расширением.
//
// Зовётся ТОЛЬКО из обработчика job 'arc-extract' (autonomous). Деградация: LLM
// вернул null → арка не обрабатывается, очередь повторит (до 3 раз), чат не страдает.

import { getSettings, backgroundJobsAllowed } from '../core/settings.js';
import { agentRequest, parseJsonLoose } from '../llm/llm-service.js';
import { noteLlmCall, enqueue } from '../core/job-queue.js';
import { getArc, arcText, setSummaryGist, setArcSignificance } from './arc-segmenter.js';
import { addGist } from './recollection.js';
import { enqueueWrite } from '../lorebook/lorebook-writer.js';
import { extractEntities } from './entity-extract.js';
import { loadGraph } from './knowledge-graph.js';
import { scoreSignificance } from './deep-extractor.js';
import { log as logActivity } from './activity-log.js';

const SCHEMA = {
  type: 'object',
  properties: {
    gist: { type: 'string' },
    voiceQuotes: { type: 'array', items: { type: 'string' } },
    triples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' }, rel: { type: 'string' },
          to: { type: 'string' }, weight: { type: 'number' },
        },
        required: ['from', 'rel', 'to'],
      },
    },
  },
  required: ['gist'],
};

/**
 * Обработать запечатанную арку. Возвращает true при успехе, false при деградации.
 * @param {number} arcId
 * @param {{force?: boolean}} [opts] force=true — ручной перезапуск из UI: обходит
 *   гейт режима (работает даже в lite) и игнорирует уже стоящий gist (пере-суммаризует).
 */
export async function summarizeArc(arcId, opts = {}) {
  const force = !!opts.force;
  const s = getSettings();
  if (s.extraction?.enabled === false && !force) return false;
  // Саммари арки — дешёвая фон-джоба: идёт во всех режимах, кроме lite (там память
  // не строится вовсе). Разовый backfill (поздно-включённый чат) пускаем даже в lite —
  // флаг живёт в chatMetadata, очередь его же чекает. Ручной force тоже проходит везде.
  const backfillActive = !!(SillyTavern.getContext().chatMetadata?.chaoticLorebooks_backfillActive);
  if (!backgroundJobsAllowed(s) && !backfillActive && !force) return false;

  const arc = getArc(arcId);
  if (!arc || !arc.sealed) return false;
  const text = arcText(arcId);
  if (!text || text.length < 20) { await setSummaryGist(arcId, ''); return false; }

  // alias-aware подсказка известных сущностей — анти-галлюцинация для триплетов.
  let knownNames = [];
  try { knownNames = Object.values((await loadGraph()).nodes).map((n) => n.name); } catch { /* ok */ }
  const quotesN = Math.max(2, Math.min(4, s.recollection?.voiceQuotesPerArc ?? 3));

  const system = 'You compress one scene ("arc") of a roleplay into durable memory. '
    + 'Output JSON only with: '
    + '"gist" (1-3 sentences, the lasting consequences of the scene, not a play-by-play); '
    + `"voiceQuotes" (${quotesN} VERBATIM short lines characters actually said, preserving voice); `
    + '"triples" (relationship changes as {from, rel, to, weight 1-10}; use SHORT relations '
    + 'like trusts/fears/loves/owes/allied_with/located_in; prefer the entity names listed if they match). '
    + 'Do NOT invent entities not present in the scene.';
  const prompt = (knownNames.length ? `Known entities: ${knownNames.slice(0, 30).join(', ')}\n\n` : '')
    + `Scene transcript:\n${text.slice(0, 6000)}`;

  let parsed;
  try {
    parsed = parseJsonLoose(await agentRequest({ system, prompt, jsonSchema: SCHEMA }));
    // Only count the call against budget AFTER a successful result — failed calls
    // should not exhaust the hourly cap and block real work.
    if (parsed && parsed.gist) noteLlmCall();
  } catch (e) {
    console.warn('[ChaoticLorebooks] summarizeArc LLM failed:', e);
    return false;
  }
  if (!parsed || !parsed.gist) return false;

  const gist = String(parsed.gist).trim();
  const voiceQuotes = Array.isArray(parsed.voiceQuotes)
    ? parsed.voiceQuotes.map(String).filter(Boolean).slice(0, quotesN) : [];
  const triples = Array.isArray(parsed.triples)
    ? parsed.triples.filter((t) => t && t.from && t.to && t.rel) : [];

  // H6: calibrated confidence — валидация сущностей и цитат по тексту арки.
  const { scoredTriples, hallucinated } = validateTriples(triples, text);
  const validatedQuotes = validateQuotes(voiceQuotes, text);

  // Фаза C: значимость арки (чистый код, синхронно) — влияет на пиннинг и приоритет
  // огрызка в момент записи. deep-extract выключен → нейтральные 0.5 (старое поведение).
  const deep = s.deepExtract?.enabled && s.autonomous?.enabled;
  const significance = deep ? scoreSignificance({ triples: scoredTriples, text, gist }) : 0.5;

  // 1) огрызок арки на саму арку + в ярус 2 (со значимостью для приоритета затухания)
  await setSummaryGist(arcId, gist);
  if (deep) await setArcSignificance(arcId, significance);
  const refs = entityKeysFromTriples(scoredTriples);
  await addGist({ gist, voiceQuotes: validatedQuotes, graphRefs: refs, arcId, significance });

  // 2) триплеты → граф. С deep-extract: сперва allow-list/дрейф (job 'deep-extract'),
  //    он сам поставит очищенный 'graph-merge'. Иначе — прямой мёрж (как в Фазе B).
  //    Галлюцинации (confidence='low') → вес ×0.5 перед мёржем.
  if (deep) {
    await enqueue('deep-extract', { arcId, triples: scoredTriples, text, gist, hallucinated });
  } else if (scoredTriples.length && s.graph?.enabled !== false) {
    await enqueue('graph-merge', { arcId, triples: scoredTriples });
  }
  // Записать галлюцинации в дрейф-флаги для ручного разбора.
  if (hallucinated.length) {
    try {
      const { addDriftFlags } = await import('./deep-extractor.js');
      const flags = hallucinated.map((h) => ({
        kind: 'hallucination',
        arcId,
        from: h.from,
        to: h.to,
        rel: h.rel,
        detail: `"${h.from}" → "${h.to}" (${h.rel}): not found in arc text`,
      }));
      await addDriftFlags(flags).catch(() => {});
    } catch { /* deep-extractor unavailable — skip flagging */ }
  }

  // 3) STANDALONE keyed-энтри арки (книга помнит и без расширения).
  //    Арка 0 = фундамент знакомства → автопин; значимая арка (≥ pinThreshold) тоже.
  const keys = deriveArcKeys(scoredTriples, text);
  const isFoundation = arc.foundation === true || arcId === 0;
  const pinned = isFoundation || (deep && significance >= (s.deepExtract?.pinThreshold ?? 0.7));
  const content = [gist, ...voiceQuotes.map((q) => `“${q}”`)].join('\n');
  await enqueueWrite({
    origin: 'auto-arc',
    tier: pinned ? 'pinned' : 'transient',
    arc: arcId,
    content,
    title: `Arc ${arcId}`,
    treePath: isFoundation ? 'Foundation' : 'Arcs',
    key: keys,
  }).catch((e) => console.warn('[ChaoticLorebooks] arc entry write failed:', e));

  logActivity({ kind: 'extract', arcId, detail: `gist + ${triples.length} triple${triples.length === 1 ? '' : 's'}` })
    .catch(() => {});

  return true;
}

function entityKeysFromTriples(triples) {
  const set = new Set();
  for (const t of triples) { if (t.from) set.add(String(t.from)); if (t.to) set.add(String(t.to)); }
  return [...set].slice(0, 12);
}

/** Ключи для standalone-энтри: сущности триплетов, иначе имена собственные из текста. */
function deriveArcKeys(triples, text) {
  const fromTriples = entityKeysFromTriples(triples);
  if (fromTriples.length) return fromTriples.slice(0, 6);
  return extractEntities(text).slice(0, 6).map((e) => e.name);
}

// --- H6: Calibrated confidence — pure-code validation ---

/**
 * Провалидировать триплеты по тексту арки. Каждая сущность (from/to) должна
 * присутствовать в тексте арки (иначе — галлюцинация). Возвращает scoredTriples
 * (с полем _confidence) и отдельно список hallucinated (confidence='low').
 */
function validateTriples(triples, arcText) {
  const norm = String(arcText ?? '').toLowerCase();
  const scored = [];
  const hallucinated = [];
  for (const t of triples) {
    const fromConf = entityConfidence(t.from, norm);
    const toConf = entityConfidence(t.to, norm);
    // Консервативно: confidence = min(from, to) — если хоть одна сущность
    // не найдена, весь триплет под подозрением.
    const conf = Math.min(fromConf, toConf);
    const scoredT = { ...t, _confidence: conf };
    if (conf < 0.4) {
      // Низкая уверенность → вес ×0.5 при мёрже в граф.
      scoredT.weight = Math.max(1, Math.round((scoredT.weight ?? 5) * 0.5));
      hallucinated.push(scoredT);
    }
    scored.push(scoredT);
  }
  return { scoredTriples: scored, hallucinated };
}

/**
 * Поиск сущности в тексте арки. exact match → 1.0, fuzzy (все слова есть) → 0.7,
 * частичное совпадение → 0.4, отсутствует → 0.1.
 */
function entityConfidence(name, normText) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return 0.5;
  // Exact substring match (имя как цельная фраза).
  if (normText.includes(n)) return 1.0;
  // Fuzzy: все токены имени присутствуют в тексте.
  const tokens = n.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => normText.includes(t))) return 0.7;
  // Частичное: хотя бы один токен >3 символов присутствует.
  if (tokens.some((t) => t.length > 3 && normText.includes(t))) return 0.4;
  // Полностью отсутствует → вероятная галлюцинация.
  return 0.1;
}

/**
 * Провалидировать voice-цитаты: каждая должна быть найдена (с вариациями
 * пунктуации/капитализации) в тексте арки. Возвращает только подтверждённые.
 */
function validateQuotes(quotes, arcText) {
  const norm = String(arcText ?? '').toLowerCase().replace(/[.,!?;:'"()\-—«»„"`'']/g, '');
  return quotes.filter((q) => {
    const qNorm = String(q).toLowerCase().replace(/[.,!?;:'"()\-—«»„"`'']/g, '');
    // Допуск: цитата длиной ≥20 символов и подстрока в очищенном тексте.
    return qNorm.length >= 8 && norm.includes(qNorm.slice(0, Math.min(qNorm.length, 60)));
  });
}

// --- Авто-регенерация пустых саммари арок ---

const EMPTY_GIST_COUNT_KEY = 'chaoticLorebooks_emptyGistRetryCount';

/**
 * Счётчик устоявшихся ходов для регенерации пустых саммари арок.
 * Возвращает true раз в N ходов (по умолчанию 3). Не учитывает свайпы —
 * MESSAGE_SWIPED не зовёт onSettledTurn.
 */
export async function noteSettledForEmptyGistRetry(every = 3) {
  const meta = SillyTavern.getContext().chatMetadata;
  if (!meta) return false;
  const n = (Number(meta[EMPTY_GIST_COUNT_KEY]) || 0) + 1;
  if (n >= every) { meta[EMPTY_GIST_COUNT_KEY] = 0; try { await SillyTavern.getContext().saveMetadata(); } catch { /* ok */ } return true; }
  meta[EMPTY_GIST_COUNT_KEY] = n;
  try { await SillyTavern.getContext().saveMetadata(); } catch { /* ok */ }
  return false;
}

/**
 * Найти все запечатанные арки с пустым summaryGist и поставить их в очередь
 * на переизвлечение (force=true, обходит lite-гейт). Возвращает число найденных.
 */
export async function retryEmptyGistArcs() {
  const { getSealedArcs, arcText } = await import('./arc-segmenter.js');
  const { enqueue } = await import('../core/job-queue.js');
  // Only retry arcs with enough text to summarize (≥20 chars) — shorter arcs
  // will never produce a useful summary and would retry indefinitely.
  const arcs = getSealedArcs().filter((a) => !a.summaryGist && (arcText(a.id)?.length ?? 0) >= 20);
  for (const a of arcs) {
    await enqueue('arc-extract', { arcId: a.id, force: true }).catch(() => {});
  }
  return arcs.length;
}
