// settings.js — настройки расширения: дефолты + merge + сохранение.
// Всё 🟢. Паттерн merge переживает обновления расширения (новые поля
// добавляются к старым настройкам пользователя без потери его значений).

export const MODULE_NAME = 'chaoticLorebooks';

// Object.freeze, чтобы дефолты случайно не мутировали.
const DEFAULTS = Object.freeze({
  enabled: true,

  // Режим одним пикером (анти-перегруз UI): задаёт вменяемые дефолты.
  // 'lite' = без фоновой LLM-работы · 'balanced' = scout-ретрив · 'autonomous' = полный (Фаза 4).
  mode: 'balanced',

  // Язык интерфейса расширения: 'auto' = как в SillyTavern (localStorage['language']),
  // 'en' / 'ru' = жёстко. Читается в i18n.js (getLang). Только UI; промпты не трогает.
  uiLanguage: 'auto',

  // --- Двухмодельная архитектура ---
  // Пустая строка = использовать текущее активное подключение ST.
  // Иначе — имя ST Connection Profile, которым работает ФОНОВЫЙ агент
  // (сбор инфы, выбор веток, обновление буфера). Основной ответ всегда
  // идёт обычной моделью пользователя — мы её не трогаем.
  agentProfile: '',

  // What the background agent uses: 'st' = ST Connection Profile (agentProfile),
  // 'custom' = a self-contained endpoint from api.profiles below.
  agentSource: 'st',

  // Self-contained custom endpoints. profiles: [{ id, name, url, key, model }].
  // The key is stored here (local, not encrypted) — flagged in the UI.
  api: {
    profiles: [],
    activeProfileId: null,
  },

  // --- Авто-лорбук ---
  // Спрашивать при первом запуске в чате без книги (выбрать/создать/отмена).
  askOnFirstUse: true,
  lorebookNameTemplate: '🌀 {{char}} — {{chat}}',

  // --- Агент / ретрив ---
  // 'recency' = дешёвый 🟢 фолбэк (свежесть + ключевые слова, без LLM).
  // 'agent'   = 🟡 scout-агент выбирает ветки и глубину дерева.
  retrievalMode: 'recency',
  // Потолок: будить агента не реже раза в N ходов (детектор сцены может чаще).
  agentEveryNTurns: 3,

  // --- Детектор сцены (🟢, без LLM) ---
  sceneDetector: {
    sensitivity: 0.5,    // 0 = редко считаем сдвигом, 1 = агрессивно
    newWordRatio: 0.5,   // доля новых слов в окне → динамический троттлинг агента
    maxTurnsCap: 8,      // never-starve: даже в статичной сцене будим раз в N ходов
  },

  // --- Буфер мыслей ---
  thoughtBuffer: {
    enabled: true,
    limitEnabled: true,   // ограничивать ли размер буфера (юзер решает)
    maxItems: 7,          // лимит размера, если limitEnabled (анти-зацикленность)
    decayPerTurn: 1,      // на сколько падает вес неподтверждённого пункта за ход
    dropThreshold: 0,     // вес <= порога → пункт выпадает из буфера
    startWeight: 5,       // вес нового/подтверждённого пункта
  },

  // --- Избранное / сохранённые вырезки ---
  favorites: {
    enabled: true,
    maxInContext: 8,      // сколько permanent-пунктов вкладывать максимум
  },

  // --- Цитаты (части соо) ---
  quotes: {
    defaultMode: 'chance', // режим новой цитаты: permanent|chance|relevant
  },

  // --- Ресёрфинг воспоминаний ---
  // Иногда ближе к концу контекста всплывает закреплённая вырезка как
  // «воспоминание». В v1 дешёвая ИИ добавит строку «как это вписывается».
  resurfacing: {
    enabled: false,       // по умолчанию выключено (рандом ломает погружение)
    chance: 0.15,         // вероятность всплытия за ход
    depth: 4,             // глубина инъекции (ближе к свежим соо: 3-4)
  },

  // --- UI ---
  slashPrefix: 'cl',

  // ============ Фаза A — фундамент ============
  // Фоновый воркер (job-queue). enabled=false → фоновые джобы не выполняются
  // (буфер/избранное/ретрив работают без него).
  autonomous: {
    enabled: false,        // включается, когда юзер готов к авто-памяти
    arcCapMessages: 40,    // дублирует arc.capMessages для пресета режима
    concurrency: 1,        // 1-2 параллельных джобы
    callsPerHour: 30,      // budget cap на платные LLM-вызовы
  },

  // Авто-скрытие старых соо пластами по арке (держит активное окно маленьким).
  autoHide: {
    enabled: true,
    windowSize: 30,        // сколько свежих соо всегда видимы
    bySlab: true,          // скрывать целой аркой, не по одному
    keepTailFromSlab: 2,   // мост: оставить N соо новейшего скрываемого пласта
  },

  // Нарезка арок.
  arc: {
    capMessages: 40,       // длина арки в соо до запечатывания
    useMarkers: true,      // /cl-arc и сцен-брейки как границы
    useStoryTime: false,   // внутриигровое время как граница (опц.)
    editDirtyThreshold: 0.10, // < этой доли изменённых слов → опечатка, арку не метим
  },

  // Бэкапы книги.
  backup: {
    enabled: true,
    keepCount: 8,          // rolling: сколько снапшотов держать
    safetyBeforeOps: true, // снапшот перед опасной авто-операцией
  },

  // ============ Фаза B — граф ссылок + ярусы памяти ============
  // Извлечение (саммари арки + триплеты). Работает ТОЛЬКО при autonomous.enabled
  // (платные LLM-вызовы идут через job-queue, вне критического пути).
  extraction: {
    enabled: true,         // мастер-тумблер конвейера извлечения
  },

  // ============ Фаза C — глубокое извлечение (значимость + дрейф) ============
  // Допроход поверх arc-summary: СТРОГИЙ allow-list триплетов (анти-галлюцинация),
  // оценка значимости арки (авто-пин/деприоритет) и дешёвый флаг дрейфа.
  // Работает только при autonomous.enabled; вне крит. пути (job-queue).
  deepExtract: {
    enabled: false,        // включается в autonomous (мастер-тумблер допрохода)
    llmMode: 'hybrid',     // 'code' = 0 LLM · 'hybrid' = код + дешёвая ИИ на спорный дрейф · 'full' = LLM-проход
    pinThreshold: 0.7,     // значимость ≥ → авто-пин арки (tier=pinned)
    lowThreshold: 0.3,     // значимость < → «филлер» (быстрее гаснет в recollection); внутр.
  },

  // Дрейф-монитор: дешёвый флаг на арку (контр-связь vs установленное ребро) +
  // дорогой кросс-арочный аудит всего графа (Фаза D, только autonomous).
  drift: {
    cheapEnabled: true,         // считать дешёвый флаг дрейфа на запечатывании арки
    sensitivity: 0.5,           // 0 = редко флагуем, 1 = агрессивно
    auditEnabled: true,         // периодический дорогой аудит (ОДИН LLM-проход; только autonomous)
    auditEveryNMessages: 500,   // ~раз в N устоявшихся ходов → enqueue 'audit-expensive'
  },

  // Ярус 2 — «воспоминания»: сжатые огрызки запечатанных арок + voiceQuotes.
  recollection: {
    enabled: true,
    maxGists: 12,          // сколько активных огрызков держать (старые гаснут)
    voiceQuotesPerArc: 3,  // дословных реплик на арку (держат стиль персонажа)
    budget: 500,           // потолок токенов инъекции яруса 2
  },

  // Ярус 3 — граф ссылок (узлы/рёбра в manifest-энтри книги).
  graph: {
    enabled: true,
    maxNodes: 40,          // мягкий потолок узлов (archiveCold косит холодные)
    subgraphHops: 2,       // глубина BFS вокруг сущностей сцены (эго-граф)
    budget: 1500,          // потолок токенов инъекции подграфа
    archiveColdAfterArcs: 8, // узел без активности N арок → archived (вне инъекции)
  },

  // Куда (глубина) класть блоки инъекции ярусов. Дефолты вменяемые; конфликт с
  // Author's Note/Summarize → юзер двигает.
  placement: {
    depthRecollection: 4,
    depthGraph: 5,
  },

  // ============ Фаза D — бюджет контекста ============
  // Один жёсткий потолок токенов на ВСЮ инъекцию памяти (буфер+избранное+огрызки+
  // граф+оглавление). Заполнение по приоритету ярусов; переполнение → condense
  // (роняет целые строки, не режет фразу), низшие ярусы падают первыми. Чистый код,
  // без LLM. Выкл → каждый ярус режется своим бюджетом как раньше (общего лимита нет).
  contextBudget: {
    enabled: false,        // мастер-тумблер глобального потолка
    target: 3000,          // потолок токенов на весь «бандл памяти»
    autoReview: true,      // авто-подсветка «Пересмотра» при насыщении бюджета
  },

  // ============ Фаза D — двухстадийный конвейер §4b (Stage-1 «движок памяти») ============
  // Дешёвая модель собирает ядро памяти (огрызки+подграф+ретрив) и отдаёт дорогой
  // (= нативной генерации ST) только дистиллят. Здесь только Stage-1 — Stage-2 (писатель)
  // это сама ST. Кэш ядра по сцене (на статике не пересобираем) + опц. Compose-проход.
  // Выкл → инъекция как v0.9.0 (всегда свежая сборка, без кэша/compose).
  pipeline: {
    enabled: false,        // scene-gated движок памяти + кэш ядра (включается в autonomous)
    composeLLM: false,     // call 2: Compose/Compress дешёвой ИИ (иначе код-сжатие). Опционально.
  },

  // ============ Фаза D — лента активности ============
  // Видимая локальная лента фоновых действий (запечатки арок, извлечение, мёрж
  // графа, дрейф, аудиты). Чистая бухгалтерия: НЕ LLM, НЕ пишет в книгу, НЕ трогает
  // инъекцию. По умолчанию ВКЛ (вся суть — прозрачность). Хранится per-chat.
  activityLog: {
    enabled: true,         // записывать фоновые действия (без LLM, локально)
    maxEntries: 100,       // rolling-потолок; старейшие выпадают первыми
  },

  // --- Таймлайн (timeline.js, Фаза D) ---
  // Единая хронология в Memory → Timeline: события активности + точки восстановления
  // (снапшоты backup.js) с кнопкой ⏪ Restore. Только UI, инъекцию не трогает; какие
  // строки показывать решают activityLog.enabled / backup.enabled.
  timeline: {
    enabled: true,         // показывать секцию Timeline (мастер-тумблер UI)
  },

  // --- Форк чата (branch-guard) ---
  // При ветвлении чата ST копирует привязку книги в ветку → таймлайны делят одну
  // книгу. Предлагаем дать ветке свою копию, чтобы память не пересекалась.
  branch: {
    enabled: true,
    askOnFork: true,            // спрашивать на входе в ветку (иначе — по defaultAction)
    defaultAction: 'fork',      // 'fork' = своя книга · 'share' = делить с родителем
    _handled: [],               // внутреннее: id веток, по которым уже решали (rolling)
  },

  // --- Глобальная книга (global-reconciler) ---
  // Если книга, в которую пишет текущий чат, активна ГЛОБАЛЬНО (selected_world_info),
  // память чата льётся во все чаты. Предлагаем приватную копию или снять с глобали.
  globalReconciler: {
    enabled: true,
    askOnDetected: true,        // спросить, когда наша книга активна глобально
    defaultAction: 'copy',      // 'copy' = приватная копия · 'disable' = убрать из глобальных · 'share' = оставить
    _handled: [],               // внутреннее: chatId, по которым уже решали (rolling)
  },
});

export function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(DEFAULTS);
  }
  // Поверхностный + один уровень вложенных объектов merge с дефолтами.
  const s = extensionSettings[MODULE_NAME];
  for (const k of Object.keys(DEFAULTS)) {
    if (!Object.hasOwn(s, k)) {
      s[k] = structuredClone(DEFAULTS[k]);
    } else if (DEFAULTS[k] && typeof DEFAULTS[k] === 'object' && !Array.isArray(DEFAULTS[k])) {
      for (const kk of Object.keys(DEFAULTS[k])) {
        if (!Object.hasOwn(s[k], kk)) s[k][kk] = DEFAULTS[k][kk];
      }
    }
  }
  return s;
}

export function saveSettings() {
  SillyTavern.getContext().saveSettingsDebounced();
}

/** Применить пресет режима к остальным настройкам (анти-перегруз UI). */
export function applyMode(mode) {
  const s = getSettings();
  s.mode = mode;
  if (mode === 'lite') {
    s.retrievalMode = 'recency';          // без фоновой LLM
    s.resurfacing.enabled = false;
    s.autonomous.enabled = false;         // фоновый воркер выключен
    s.contextBudget.enabled = false;      // без управляемой памяти — без потолка
  } else if (mode === 'balanced') {
    s.retrievalMode = 'agent';
    s.agentEveryNTurns = 3;
    s.autonomous.enabled = false;         // арки/скрытие идут, но без платных фон-джоб
    s.contextBudget.enabled = true;       // Фаза D: потолок — чистый код, без LLM → можно
  } else if (mode === 'autonomous') {
    s.retrievalMode = 'agent';
    s.agentEveryNTurns = 2;
    s.autonomous.enabled = true;          // фундамент Фазы A собран → включаем воркер
    // Фаза B: конвейер извлечения (саммари арки + мёрж графа) работает только при
    // autonomous.enabled. Инъекция ярусов 2/3 (огрызки/подграф) — БЕЗ LLM, идёт во
    // всех режимах, если в памяти уже есть данные.
    s.extraction.enabled = true;
    // Фаза C: допроход глубокого извлечения (allow-list + значимость + дрейф) —
    // тоже только в autonomous. llmMode держим как выбрал юзер (дефолт hybrid).
    s.deepExtract.enabled = true;
    // Фаза D: глобальный потолок инъекции (чистый код) — на полную память тем более.
    s.contextBudget.enabled = true;
    // Фаза D §4b: двухстадийный конвейер — scene-gated движок памяти + кэш ядра.
    // composeLLM (доп. дешёвый вызов на сдвиге сцены) оставляем юзеру — дефолт выкл.
    s.pipeline.enabled = true;
  }
  saveSettings();
  return s;
}
