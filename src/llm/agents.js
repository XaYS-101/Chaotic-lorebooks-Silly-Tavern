// agents.js — агентный слой. Заменяет нативный tool-calling двумя фоновыми
// проходами через llm-service (дешёвая модель). Каждый проход НЕОБЯЗАТЕЛЕН:
// при ошибке/выключенном LLM откатываемся на 🟢-логику, чат не страдает.
//
// 1) scout — читает сцену + оглавление дерева, решает какие ветки и насколько
//    глубоко поднять, и ОБЪЯСНЯЕТ почему (это объяснение мы вкладываем вместе
//    с данными — чтобы сохранить тезис «активного ретрива»).
// 2) bufferAgent — обновляет буфер мыслей (1-2 строки) по последним сообщениям.
//
// Метки: 🟡 (нужен LLM). Деградация встроена.

import { agentRequest, parseJsonLoose } from './llm-service.js';
import { renderToc, getBranchContent } from '../lorebook/tree-store.js';
import { upsertItem } from '../memory/thought-buffer.js';

function recentChatText(n = 6) {
  const chat = SillyTavern.getContext().chat ?? [];
  return chat.slice(-n).map((m) => `${m.name}: ${m.mes}`).join('\n');
}

/**
 * Scout: вернуть { branches:[], depth:int, reason:string } или null (фолбэк).
 */
export async function scout() {
  const toc = await renderToc();
  if (!toc) return null;

  const system = 'You are a retrieval scout for a roleplay. Decide which lorebook '
    + 'branches are relevant to the CURRENT scene and how deep to go. '
    + 'Reply ONLY as JSON: {"branches":["Name",...],"depth":1-3,"reason":"short why"}.';
  const prompt = `Memory map:\n${toc}\n\nRecent scene:\n${recentChatText()}\n\n`
    + 'Which branches matter right now?';

  const raw = await agentRequest({ system, prompt });
  const parsed = parseJsonLoose(raw);
  if (!parsed || !Array.isArray(parsed.branches)) return null;
  return parsed;
}

/** Собрать инъекцию ретрива: данные веток + рассуждение scout (или null). */
export async function retrieveWithReason() {
  const plan = await scout();
  if (!plan || !plan.branches.length) return null;
  const content = await getBranchContent(plan.branches);
  if (!content) return null;
  return `[You actively recalled the following because: ${plan.reason || 'it is relevant to the scene'}]\n${content}`;
}

/** Buffer agent: предложить 1-2 пункта в буфер мыслей. Без возврата — пишет сам. */
export async function updateBufferFromScene() {
  const system = 'Track the character\'s evolving working memory for a roleplay. '
    + 'From the recent scene, output 1-2 SHORT items that should persist briefly '
    + '(current goal, active emotional thread, or a fact just learned). '
    + 'For each give: text, kind (goal|trait|lore|thread), subject (main entity it is about), '
    + 'importance (1=minor, 2=normal, 3=core/long-term). '
    + 'Reply ONLY as JSON: {"items":[{"text":"...","kind":"...","subject":"...","importance":2}]}.';
  const prompt = `Recent scene:\n${recentChatText()}`;

  const raw = await agentRequest({ system, prompt });
  const parsed = parseJsonLoose(raw);
  if (!parsed || !Array.isArray(parsed.items)) return;
  for (const it of parsed.items.slice(0, 2)) {
    if (it?.text) {
      await upsertItem({
        text: String(it.text),
        kind: it.kind || 'thread',
        subject: it.subject,
        importance: it.importance,
      });
    }
  }
}
