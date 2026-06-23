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

import { getSettings } from '../core/settings.js';
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
 */
export async function summarizeArc(arcId) {
  const s = getSettings();
  if (s.extraction?.enabled === false) return false;
  // На время разового backfill'а (поздно-включённый чат) пускаем извлечение и в
  // Balanced/Lite — флаг живёт в chatMetadata, очередь его же чекает.
  const backfillActive = !!(SillyTavern.getContext().chatMetadata?.chaoticLorebooks_backfillActive);
  if (!s.autonomous?.enabled && !backfillActive) return false;

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
    noteLlmCall();
    parsed = parseJsonLoose(await agentRequest({ system, prompt, jsonSchema: SCHEMA }));
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

  // Фаза C: значимость арки (чистый код, синхронно) — влияет на пиннинг и приоритет
  // огрызка в момент записи. deep-extract выключен → нейтральные 0.5 (старое поведение).
  const deep = s.deepExtract?.enabled && s.autonomous?.enabled;
  const significance = deep ? scoreSignificance({ triples, text, gist }) : 0.5;

  // 1) огрызок арки на саму арку + в ярус 2 (со значимостью для приоритета затухания)
  await setSummaryGist(arcId, gist);
  if (deep) await setArcSignificance(arcId, significance);
  const refs = entityKeysFromTriples(triples);
  await addGist({ gist, voiceQuotes, graphRefs: refs, arcId, significance });

  // 2) триплеты → граф. С deep-extract: сперва allow-list/дрейф (job 'deep-extract'),
  //    он сам поставит очищенный 'graph-merge'. Иначе — прямой мёрж (как в Фазе B).
  if (deep) {
    await enqueue('deep-extract', { arcId, triples, text, gist });
  } else if (triples.length && s.graph?.enabled !== false) {
    await enqueue('graph-merge', { arcId, triples });
  }

  // 3) STANDALONE keyed-энтри арки (книга помнит и без расширения).
  //    Арка 0 = фундамент знакомства → автопин; значимая арка (≥ pinThreshold) тоже.
  const keys = deriveArcKeys(triples, text);
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
