// llm-service.js — single router for background agent requests to the LLM.
// Routes by agentSource (custom endpoint / ST profile / current connection) and
// never breaks chat: any failure returns null so the caller falls back.

import { getSettings } from '../core/settings.js';

// Send a background agent request. Returns the response text, or null on failure.
// opts: { system, prompt, jsonSchema? }
export async function agentRequest({ system, prompt, jsonSchema }) {
  const ctx = SillyTavern.getContext();
  const s = getSettings();
  const { agentProfile, agentSource } = s;

  try {
    // Custom OpenAI-compatible endpoint; on miss/failure falls back to current connection.
    if (agentSource === 'custom') {
      const p = (s.api?.profiles || []).find((x) => x && x.id === s.api?.activeProfileId);
      if (p?.url && p?.model) {
        const r = await customEndpointRequest(p, system, prompt);
        if (r != null) return r;
      }
      return await fallbackQuiet(ctx, system, prompt, jsonSchema);
    }

    // ST Connection Profile (two-model setup) via ConnectionManagerRequestService.
    if (agentSource === 'st' && agentProfile && ctx.ConnectionManagerRequestService?.sendRequest) {
      const res = await ctx.ConnectionManagerRequestService.sendRequest(
        agentProfile,
        [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        1024,
      );
      return typeof res === 'string' ? res : (res?.content ?? res?.text ?? null);
    }

    // Fallback: current connection (always available).
    return await fallbackQuiet(ctx, system, prompt, jsonSchema);
  } catch (err) {
    console.warn('[ChaoticLorebooks] agentRequest failed, falling back:', err);
    return null;
  }
}

// Background generation on ST's current connection (not rendered into chat).
async function fallbackQuiet(ctx, system, prompt, jsonSchema) {
  const text = await ctx.generateQuietPrompt({
    quietPrompt: `${system}\n\n${prompt}`,
    ...(jsonSchema ? { jsonSchema } : {}),
  });
  return text ?? null;
}

// POST to a custom OpenAI-compatible /chat/completions. Never throws — returns
// null on any error so the caller falls back. p: { url, key?, model }.
async function customEndpointRequest(p, system, prompt) {
  try {
    const url = normalizeChatUrl(p.url);
    const headers = { 'Content-Type': 'application/json' };
    if (p.key) headers.Authorization = `Bearer ${p.key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1024,
      }),
    });
    if (!res.ok) {
      console.warn('[ChaoticLorebooks] custom endpoint HTTP', res.status);
      return null;
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.warn('[ChaoticLorebooks] custom endpoint failed:', err);
    return null;
  }
}

// Normalize a base URL to .../chat/completions (append the path if missing).
function normalizeChatUrl(raw) {
  let u = String(raw || '').trim().replace(/\s+/g, '');
  u = u.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;          // already a full path
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`; // ends in /v1 → append
  return `${u}/v1/chat/completions`;                      // bare host → default path
}

// Tolerant JSON parse of a model reply (strips ```json fences).
export function parseJsonLoose(text) {
  if (!text) return null;
  try {
    const clean = String(text).replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}
