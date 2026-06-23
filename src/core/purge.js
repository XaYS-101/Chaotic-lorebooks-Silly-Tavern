// purge.js — fully removing the extension's footprint (settings + per-chat metadata).
// Our metadata (chaoticLorebooks_*) lives inside every chat file we touched, but ST
// keeps only the open chat in memory. Three complementary mechanisms:
//   1) purgeCurrentChat()      — strip keys from the open chat (in memory).
//   2) deepPurgeAllChats()     — sweep every character chat via ST's server endpoints.
//   3) backstop (localStorage) — survives the settings wipe; scrubs each chat on open.

const PREFIX = 'chaoticLorebooks_';
const LS_KEY = 'chaoticLorebooks_purgeBackstop';
const BACKSTOP_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // self-clears after 30 days
const CLEANED_CAP = 2000;                            // how many cleaned chat ids we remember

function ctx() { return SillyTavern.getContext(); }

// Delete every prefixed key from a metadata object; returns the count removed.
function stripPrefix(metaObj) {
  if (!metaObj || typeof metaObj !== 'object') return 0;
  let n = 0;
  for (const k of Object.keys(metaObj)) {
    if (k.startsWith(PREFIX)) { delete metaObj[k]; n++; }
  }
  return n;
}

function currentChatId() {
  try { return ctx().getCurrentChatId?.() ?? null; } catch { return null; }
}

// Strip our keys from the open chat and save. Returns the count removed.
export async function purgeCurrentChat() {
  const c = ctx();
  let n = 0;
  try {
    n = stripPrefix(c.chatMetadata);
    if (n > 0) await c.saveMetadata?.();
  } catch (e) {
    console.warn('[ChaoticLorebooks] purgeCurrentChat failed:', e);
  }
  return n;
}

// --- Backstop (localStorage survives delete extensionSettings) ---

function readState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.until || Date.now() > o.until) { disarmBackstop(); return null; }
    if (!Array.isArray(o.cleaned)) o.cleaned = [];
    return o;
  } catch { return null; }
}
function writeState(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch { /* private mode — ignore */ }
}

// Arm the on-open self-cleanup.
export function armBackstop() {
  writeState({ until: Date.now() + BACKSTOP_TTL_MS, cleaned: [] });
}
// Disarm the on-open self-cleanup.
export function disarmBackstop() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}
// Whether the self-cleanup is currently armed.
export function backstopActive() { return !!readState(); }

// CHAT_CHANGED hook: if armed and this chat wasn't cleaned yet, strip our keys once.
export async function purgeCurrentChatIfArmed() {
  const state = readState();
  if (!state) return;
  const id = currentChatId();
  if (id == null) return;
  if (state.cleaned.includes(id)) return;
  try {
    await purgeCurrentChat();
    state.cleaned.push(id);
    if (state.cleaned.length > CLEANED_CAP) state.cleaned.splice(0, state.cleaned.length - CLEANED_CAP);
    writeState(state);
  } catch (e) {
    console.warn('[ChaoticLorebooks] backstop purge failed:', e);
  }
}

// --- Active sweep of all character chats via ST's own server endpoints ---
// Only rewrites files that actually contain our keys, removing nothing else.
// @returns {Promise<{scanned,cleaned,empty,failed, noNetwork?:boolean}>}
export async function deepPurgeAllChats(onProgress) {
  const c = ctx();
  const result = { scanned: 0, cleaned: 0, empty: 0, failed: 0 };

  // Current chat first, in memory (avoids clobbering unsaved state).
  try { await purgeCurrentChat(); } catch { /* backstop covers it */ }

  const getHeaders = c.getRequestHeaders;
  const characters = Array.isArray(c.characters) ? c.characters : [];
  if (typeof getHeaders !== 'function') {
    return { ...result, noNetwork: true };
  }

  const currentFile = currentChatId();

  for (const ch of characters) {
    const avatar = ch?.avatar;
    if (!avatar) continue;

    let list;
    try {
      const r = await fetch('/api/characters/chats', {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({ avatar_url: avatar, simple: true }),
      });
      if (!r.ok) { result.failed++; continue; }
      list = await r.json();
    } catch { result.failed++; continue; }
    if (!Array.isArray(list)) continue;

    for (const item of list) {
      const fileId = item?.file_id ?? String(item?.file_name || '').replace(/\.jsonl$/i, '');
      if (!fileId) continue;
      if (fileId === currentFile) continue;
      result.scanned++;
      try {
        const gr = await fetch('/api/chats/get', {
          method: 'POST', headers: getHeaders(),
          body: JSON.stringify({ avatar_url: avatar, file_name: fileId }),
        });
        if (!gr.ok) { result.failed++; continue; }
        const data = await gr.json();
        const arr = Array.isArray(data) ? data : null;
        if (!arr || !arr.length || !arr[0] || typeof arr[0] !== 'object') { result.empty++; continue; }

        const removed = stripPrefix(arr[0].chat_metadata);
        if (removed <= 0) { result.empty++; continue; }

        const sr = await fetch('/api/chats/save', {
          method: 'POST', headers: getHeaders(),
          body: JSON.stringify({ avatar_url: avatar, file_name: fileId, chat: arr, force: true }),
        });
        if (!sr.ok) { result.failed++; continue; }
        result.cleaned++;
      } catch { result.failed++; }
      onProgress?.(result);
    }
  }
  return result;
}
