// chat-state.js — per-chat toggle "extension disabled for THIS chat".
// Leaf module: zero extension imports (reads only getContext()), so it can be
// imported anywhere without cycles. The flag lives in chatMetadata (per-chat,
// survives reload, inherited by forks — fine: a branch is intentionally off too).
//
// Semantics: key absent / false → enabled (default ON). true → disabled for chat.

const KEY = 'chaoticLorebooks_chatOff';

function ctx() { return SillyTavern.getContext(); }

/** Whether the extension is enabled for the current chat (default yes). */
export function isChatEnabled() {
  try { return ctx().chatMetadata?.[KEY] !== true; } catch { return true; }
}

/** Explicitly set the state for the current chat and persist metadata. */
export async function setChatEnabled(on) {
  try {
    const meta = ctx().chatMetadata;
    if (!meta) return;
    if (on) delete meta[KEY]; else meta[KEY] = true;   // enabled = absence of flag (clean)
    await ctx().saveMetadata();
  } catch (e) {
    console.warn('[ChaoticLorebooks] setChatEnabled failed:', e);
  }
}

/** Toggle and return the NEW state (true = now enabled). */
export async function toggleChatEnabled() {
  const next = !isChatEnabled();
  await setChatEnabled(next);
  return next;
}
