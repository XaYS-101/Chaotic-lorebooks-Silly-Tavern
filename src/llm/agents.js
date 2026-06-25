// agents.js — agent layer. Replaces native tool-calling with two background
// passes via llm-service (cheap model). Each pass is OPTIONAL: on error or with
// LLM off we fall back to 🟢 logic, chat is unaffected.
//
// 1) scout — reads the scene + tree ToC, decides which branches to surface and
//    how deep, and EXPLAINS why (the explanation is injected with the data to
//    preserve the "active retrieval" framing).
// 2) bufferAgent — updates the thought buffer (1-2 lines) from recent messages.
//
// Markers: 🟡 (needs LLM). Degradation built in.

import { agentRequest, parseJsonLoose } from './llm-service.js';
import { renderToc, getBranchContent } from '../lorebook/tree-store.js';
import { upsertItem } from '../memory/thought-buffer.js';
import { trace } from '../core/debug-trace.js';

const BUFFER_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['goal', 'trait', 'lore', 'thread'] },
          subject: { type: 'string' },
          importance: { type: 'integer', minimum: 1, maximum: 3 },
        },
        required: ['text', 'kind', 'importance'],
      },
    },
  },
  required: ['items'],
};

function recentChatText(n = 6) {
  const chat = SillyTavern.getContext().chat ?? [];
  return chat.slice(-n).map((m) => `${m.name}: ${m.mes}`).join('\n');
}

/**
 * Scout: return { branches:[], depth:int, reason:string } or null (fallback).
 */
export async function scout() {
  const toc = await renderToc();
  if (!toc) return null;

  const system = 'You are a retrieval scout for a roleplay. Decide which lorebook '
    + 'branches are relevant to the CURRENT scene and how deep to go. '
    + 'Reply ONLY as JSON: {"branches":["Name",...],"depth":1-3,"reason":"short why"}.';
  const prompt = `Memory map:\n${toc}\n\nRecent scene:\n${recentChatText()}\n\n`
    + 'Which branches matter right now?';

  trace('agent.req', { kind: 'scout' });
  const raw = await agentRequest({ system, prompt, jsonSchema: SCOUT_SCHEMA, retries: 1 });
  const parsed = parseJsonLoose(raw);
  trace('agent.resp', { kind: 'scout', ok: !!(parsed && Array.isArray(parsed.branches)) });
  if (!parsed || !Array.isArray(parsed.branches)) return null;
  // Hard cap regardless of what the model returned — bound the injection size.
  parsed.branches = parsed.branches.slice(0, 5);
  return parsed;
}

/** Build retrieval injection: branch data + scout reasoning (or null). */
export async function retrieveWithReason() {
  const plan = await scout();
  if (!plan || !plan.branches.length) return null;
  const content = await getBranchContent(plan.branches);
  if (!content) return null;
  return `[You actively recalled the following because: ${plan.reason || 'it is relevant to the scene'}]\n${content}`;
}

const BUF_LAST_IDX_KEY = 'chaoticLorebooks_lastBufferUpdateIdx';

const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    branches: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    depth: { type: 'integer', minimum: 1, maximum: 3 },
    reason: { type: 'string' },
  },
  required: ['branches', 'depth', 'reason'],
};

/** Buffer agent: propose 1-2 thought-buffer items. No return — writes directly. */
export async function updateBufferFromScene() {
  const ctx = SillyTavern.getContext();
  const chatLen = (ctx.chat ?? []).length;
  // VoI gate: skip if already processed this exact chat position (debounce).
  const lastIdx = Number(ctx.chatMetadata?.[BUF_LAST_IDX_KEY]) || 0;
  // If the chat shrank (messages deleted / branch), the saved index is stale —
  // reset it and proceed, otherwise the agent would stall permanently.
  if (chatLen < lastIdx) {
    if (ctx.chatMetadata) ctx.chatMetadata[BUF_LAST_IDX_KEY] = 0;
  } else if (chatLen <= lastIdx && chatLen > 0) {
    return;
  }

  const system = 'Track the character\'s evolving working memory for a roleplay. '
    + 'From the recent scene, output 1-2 SHORT items worth keeping. '
    + 'kind: "goal" = an objective the character is pursuing (fades once met or abandoned); '
    + '"trait" = a feeling or character-state about someone (e.g. love, fear, distrust); '
    + '"lore" = a durable fact just learned; "thread" = a fleeting conversational beat. '
    + 'subject = main entity it is about. '
    + 'importance: 1 = fleeting (drops soon), 2 = normal, '
    + '3 = ENDURING CONSTANT — only for trait/lore that should persist long-term, like a core '
    + 'lasting feeling, a defining character trait, or a permanent fact (these never decay). '
    + 'Use 3 for steady feelings/character constants; use "thread" + 1 for one-off beats; '
    + 'give goals importance by how long-term they are (a quick errand is 1, a driving ambition 2-3). '
    + 'Reply ONLY as JSON: {"items":[{"text":"...","kind":"...","subject":"...","importance":2}]}.';
  const prompt = `Recent scene:\n${recentChatText()}`;

  trace('agent.req', { kind: 'buffer' });
  const raw = await agentRequest({ system, prompt, jsonSchema: BUFFER_SCHEMA, retries: 2 });
  const parsed = parseJsonLoose(raw);
  trace('agent.resp', { kind: 'buffer', ok: !!(parsed && Array.isArray(parsed.items)), items: parsed?.items?.length ?? 0 });
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
  // Debounce guard: mark this chat position as processed.
  if (ctx.chatMetadata) {
    ctx.chatMetadata[BUF_LAST_IDX_KEY] = chatLen;
    try { ctx.saveMetadata(); } catch { /* ok */ }
  }
}
