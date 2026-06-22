// context-budget.js — глобальный потолок токенов на ВСЮ инъекцию памяти (Фаза D).
// Сегодня каждый ярус режется своим бюджетом независимо (recollection.budget,
// graph.budget; буфер/избранное — только по числу пунктов), общего лимита нет —
// в сумме они могут превысить любой target. Этот модуль кладёт ОДИН жёсткий
// потолок (contextBudget.target) поверх собранного «бандла памяти»: заполняет по
// приоритету ярусов, при переполнении — condense (роняет целые строки/огрызки/рёбра,
// НИКОГДА не режет середину фразы), роняет первыми ярусы с низшим приоритетом.
//
// Чистый код, без LLM. Деградация: нет getTokenCountAsync → ~4 симв/токен, чат не
// блокируется. review() только ФЛАГ кандидатов на чистку (железное правило: ничего
// не удаляем автоматически — юзер жмёт «забыть» сам).
//
// Метки: 🟢. Зависит только от настроек + метаданных (recollection).

import { getSettings } from '../core/settings.js';
import { getGists } from './recollection.js';

// --- Отчёт последней сборки (читает UI для индикатора здоровья памяти) ---
let lastReport = null;
export function getLastReport() { return lastReport; }
export function setLastReport(r) { lastReport = r; }

function clampSig(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Оценить число токенов в тексте. Точный счётчик ST при наличии, иначе ~4 симв/токен.
 * @returns {Promise<number>}
 */
export async function estimate(text) {
  const t = String(text ?? '');
  if (!t) return 0;
  const c = SillyTavern.getContext();
  if (typeof c.getTokenCountAsync === 'function') {
    try {
      const n = await c.getTokenCountAsync(t, 0);
      if (Number.isFinite(n)) return n;
    } catch { /* падаем на грубую оценку */ }
  }
  return Math.ceil(t.length / 4);
}

/**
 * Подрезать блок под бюджет токенов, СОХРАНЯЯ заголовок (первую строку, напр.
 * «[Relationship graph …]») и роняя ЦЕЛЫЕ строки тела — так инъекция не превращается
 * в обрывок фразы. Выбор строк по дешёвой оценке (4 симв/токен) с 10% запасом, чтобы
 * итог почти наверняка влез под точный счётчик. Если даже заголовок не лезет → ''.
 * @returns {Promise<string>}
 */
export async function condense(text, tokenBudget) {
  const lines = String(text ?? '').split('\n');
  const header = lines[0] ?? '';
  const charBudget = Math.max(40, Math.floor((tokenBudget || 0) * 4 * 0.9));
  if (header.length > charBudget) return '';
  let out = header;
  for (let i = 1; i < lines.length; i++) {
    if (out.length + 1 + lines[i].length > charBudget) break;
    out += `\n${lines[i]}`;
  }
  return out;
}

/**
 * Глобальная подгонка под потолок. blocks = [{tier, text, priority}] в порядке сборки.
 * Резерв под memText (ресёрфинг, инжектится отдельной глубиной, но считается в потолок).
 * Заполняем по убыванию приоритета; не влез целиком — condense; не лезет и заголовок —
 * роняем ярус (пишем в report.dropped). Возвращаем текст в ИСХОДНОМ порядке (читаемость).
 * @param {Array<{tier:string,text:string,priority:number}>} blocks
 * @param {number} target потолок токенов на всю память
 * @param {string} [memText] текст ресёрфинга (резервируется первым)
 * @returns {Promise<{text:string, report:object}>}
 */
export async function fitBudget(blocks, target, memText) {
  const list = (blocks || []).filter((b) => b && b.text);
  list.forEach((b, i) => { b._ord = i; });

  const memTokens = memText ? await estimate(memText) : 0;
  const budget = Math.max(0, (target || 0) - memTokens);

  const byPri = list.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const perTier = {};
  const dropped = [];
  const kept = [];
  let used = 0;

  for (const b of byPri) {
    const remaining = budget - used;
    if (remaining <= 0) { dropped.push(b.tier); continue; }
    // eslint-disable-next-line no-await-in-loop
    const full = await estimate(b.text);
    if (full <= remaining) {
      b._final = b.text;
      used += full;
      perTier[b.tier] = (perTier[b.tier] || 0) + full;
      kept.push(b);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const cond = await condense(b.text, remaining);
    // eslint-disable-next-line no-await-in-loop
    const ct = cond ? await estimate(cond) : 0;
    if (cond && ct > 0 && ct <= remaining) {
      b._final = cond;
      used += ct;
      perTier[b.tier] = (perTier[b.tier] || 0) + ct;
      kept.push(b);
    } else {
      dropped.push(b.tier);
    }
  }

  kept.sort((a, b) => a._ord - b._ord);
  const text = kept.map((b) => b._final).join('\n\n');
  const report = {
    target: target || 0,
    used: used + memTokens,
    mem: memTokens,
    perTier,
    dropped,
    at: Date.now(),
  };
  setLastReport(report);
  return { text, report };
}

/**
 * Нужно ли подсветить «Пересмотр»? true, когда память почти заполнила потолок.
 * Чистый код, без LLM. Управляется contextBudget.autoReview.
 */
export function autoReview(report) {
  const s = getSettings();
  if (!s.contextBudget?.autoReview) return false;
  if (!report || !report.target) return false;
  return (report.used / report.target) >= 0.95;
}

/**
 * Код-ревью «что чистить»: активные огрызки малой значимости (< lowThreshold),
 * старые первыми — это главный прунабельный инжектируемый ярус. НИЧЕГО не мутирует,
 * только список кандидатов (UI даёт кнопку «забыть» = active=false, восстановимо).
 * @returns {Promise<{candidates:Array<{kind,id,label,reason}>, summary:string}>}
 */
export async function review() {
  const s = getSettings();
  const lo = s.deepExtract?.lowThreshold ?? 0.3;
  const candidates = [];

  const stale = getGists()
    .filter((g) => g.active !== false && clampSig(g.significance) < lo)
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
  for (const g of stale) {
    candidates.push({
      kind: 'gist',
      id: g.id,
      label: `arc ${g.arcId ?? '?'}: ${String(g.gist).slice(0, 60)}`,
      reason: `low significance ${clampSig(g.significance).toFixed(2)}`,
    });
  }

  const summary = candidates.length
    ? `${candidates.length} low-value recollection${candidates.length === 1 ? '' : 's'} — forget to free budget.`
    : 'Nothing stale to prune — memory is lean.';
  return { candidates, summary };
}
