// llm-service.js — РОУТЕР запросов к модели.
// Единственная точка, через которую агентный слой обращается к LLM.
// Задача: отправить фоновый запрос ВЫБРАННЫМ профилем (дешёвая/быстрая модель),
// распарсить JSON, и НИКОГДА не уронить чат — при любой ошибке вернуть null,
// чтобы вызывающий код откатился на 🟢-фолбэк.

import { getSettings } from '../core/settings.js';

/**
 * Отправить агентный запрос. Возвращает текст ответа или null при ошибке.
 * @param {object} opts
 * @param {string} opts.system  — системная инструкция
 * @param {string} opts.prompt  — пользовательский промпт
 * @param {object} [opts.jsonSchema] — опц. схема для structured output
 */
export async function agentRequest({ system, prompt, jsonSchema }) {
  const ctx = SillyTavern.getContext();
  const { agentProfile } = getSettings();

  try {
    // --- Путь 1: отдельный Connection Profile (двухмодельная схема) ---
    // ⚠️ FLAG: точную сигнатуру отправки запроса конкретным профилем нужно
    // сверить с исходниками ST. В свежих версиях это примерно:
    //   ctx.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens)
    // Пока профиль не выбран или сервис недоступен — падаем на Путь 2.
    if (agentProfile && ctx.ConnectionManagerRequestService?.sendRequest) {
      const res = await ctx.ConnectionManagerRequestService.sendRequest(
        agentProfile,
        [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        1024,
      );
      // Формат ответа сервиса тоже сверить (res.content / res.text / строка).
      return typeof res === 'string' ? res : (res?.content ?? res?.text ?? null);
    }

    // --- Путь 2: фолбэк на текущее подключение (работает всегда) ---
    // generateQuietPrompt — фоновая генерация в контексте чата, не рендерится.
    const text = await ctx.generateQuietPrompt({
      quietPrompt: `${system}\n\n${prompt}`,
      ...(jsonSchema ? { jsonSchema } : {}),
    });
    return text ?? null;
  } catch (err) {
    console.warn('[ChaoticLorebooks] agentRequest failed, falling back:', err);
    return null;
  }
}

/** Безопасный парс JSON из ответа модели (вырезает ```json-обёртки). */
export function parseJsonLoose(text) {
  if (!text) return null;
  try {
    const clean = String(text).replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}
