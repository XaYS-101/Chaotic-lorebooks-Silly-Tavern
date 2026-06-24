// llm-service.js — single router for background agent requests to the LLM.
// Routes by agentSource (custom endpoint / ST profile / current connection) and
// never breaks chat: any failure returns null so the caller falls back.

import { getSettings } from '../core/settings.js';

// Send a background agent request. Returns the response text, or null on failure.
// opts: { system, prompt, jsonSchema?, retries?: number (default 1 → 2 total attempts) }
// Retries only on transient failures (network, timeout, 5xx), not parse errors.
export async function agentRequest({ system, prompt, jsonSchema, retries = 1 }) {
  const ctx = SillyTavern.getContext();
  const s = getSettings();
  const { agentProfile, agentSource } = s;
  const maxAttempts = Math.max(1, Math.min(3, (retries ?? 1) + 1)); // 2–4 total

  // Build a compact schema reminder for paths that can't pass structured-output natively.
  const schemaHint = jsonSchema ? schemaAsPromptHint(jsonSchema) : '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      let result = null;

      // Custom OpenAI-compatible endpoint; on miss/failure falls back to current connection.
      if (agentSource === 'custom') {
        const p = (s.api?.profiles || []).find((x) => x && x.id === s.api?.activeProfileId);
        if (p?.url && p?.model) {
          result = await customEndpointRequest(p, system, prompt, jsonSchema, schemaHint);
        }
        if (result == null) {
          result = await fallbackQuiet(ctx, system, prompt, jsonSchema, schemaHint);
        }
      } else if (agentSource === 'st' && agentProfile && ctx.ConnectionManagerRequestService?.sendRequest) {
        // ST Connection Profile — append schema hint to system prompt since sendRequest
        // doesn't expose structured-output params.
        const sys = schemaHint ? `${system}\n\n${schemaHint}` : system;
        const res = await ctx.ConnectionManagerRequestService.sendRequest(
          agentProfile,
          [
            { role: 'system', content: sys },
            { role: 'user', content: prompt },
          ],
          1024,
        );
        result = typeof res === 'string' ? res : (res?.content ?? res?.text ?? null);
      } else {
        // Fallback: current connection (always available).
        result = await fallbackQuiet(ctx, system, prompt, jsonSchema, schemaHint);
      }

      if (result != null) return result;
    } catch (err) {
      console.warn(`[ChaoticLorebooks] agentRequest attempt ${attempt + 1}/${maxAttempts} failed:`, err);
    }

    // Don't retry on last attempt.
    if (attempt < maxAttempts - 1) {
      await sleep(250 * Math.pow(2, attempt)); // 250ms, 500ms, 1000ms
    }
  }

  return null;
}

// Background generation on ST's current connection (not rendered into chat).
async function fallbackQuiet(ctx, system, prompt, jsonSchema, schemaHint) {
  const sys = schemaHint ? `${system}\n\n${schemaHint}` : system;
  const text = await ctx.generateQuietPrompt({
    quietPrompt: `${sys}\n\n${prompt}`,
    ...(jsonSchema ? { jsonSchema } : {}),
  });
  return text ?? null;
}

// POST to a custom OpenAI-compatible /chat/completions. Never throws — returns
// null on any error so the caller falls back. p: { url, key?, model }.
// jsonSchema: adds response_format (best-effort); schemaHint: appended to system prompt.
async function customEndpointRequest(p, system, prompt, jsonSchema, schemaHint) {
  try {
    const url = normalizeChatUrl(p.url);
    const headers = { 'Content-Type': 'application/json' };
    if (p.key) headers.Authorization = `Bearer ${p.key}`;
    const sys = schemaHint ? `${system}\n\n${schemaHint}` : system;
    const body = {
      model: p.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
    };
    // Best-effort structured output for OpenAI-compatible endpoints.
    // json_object is more widely supported than json_schema across providers.
    if (jsonSchema) {
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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

/** Compact one-line schema reminder for paths that can't pass structured-output natively. */
function schemaAsPromptHint(schema) {
  if (!schema) return '';
  const props = schema?.properties ? Object.keys(schema.properties).join(', ') : '';
  const req = schema?.required?.length ? ` (required: ${schema.required.join(', ')})` : '';
  return `OUTPUT MUST BE JSON with fields: ${props}${req}. No markdown, no commentary.`;
}

/** Promise-based sleep (ms). */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
