// chat-state.js — пер-чатовый тумблер «расширение выключено для ЭТОГО чата».
// Лист-модуль: НОЛЬ extension-импортов (читает только getContext()) → импортится
// откуда угодно без цикла. Флаг живёт в chatMetadata (свой на чат, переживает
// перезагрузку, форк наследует — но это ок: ветка тоже выключена осознанно).
//
// Семантика: ключа нет / false → включено (дефолт ON). true → выключено для чата.

const KEY = 'chaoticLorebooks_chatOff';

function ctx() { return SillyTavern.getContext(); }

/** Включено ли расширение для текущего чата (дефолт — да). */
export function isChatEnabled() {
  try { return ctx().chatMetadata?.[KEY] !== true; } catch { return true; }
}

/** Явно задать состояние для текущего чата и сохранить метаданные. */
export async function setChatEnabled(on) {
  try {
    const meta = ctx().chatMetadata;
    if (!meta) return;
    if (on) delete meta[KEY]; else meta[KEY] = true;   // включено = отсутствие флага (чисто)
    await ctx().saveMetadata();
  } catch (e) {
    console.warn('[ChaoticLorebooks] setChatEnabled failed:', e);
  }
}

/** Переключить и вернуть НОВОЕ состояние (true = теперь включено). */
export async function toggleChatEnabled() {
  const next = !isChatEnabled();
  await setChatEnabled(next);
  return next;
}
