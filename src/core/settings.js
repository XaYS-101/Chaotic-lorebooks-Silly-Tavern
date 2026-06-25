// settings.js — extension settings: defaults + merge + persistence.
// All 🟢. The merge pattern survives extension updates (new fields are added to
// the user's old settings without losing their values).

export const MODULE_NAME = 'chaoticLorebooks';

// Object.freeze so the defaults can't be mutated by accident.
const DEFAULTS = Object.freeze({
  enabled: true,

  // Single-picker mode (anti UI-overload): sets sensible defaults.
  // 'lite' = no background LLM work · 'balanced' = scout retrieval · 'autonomous' = full (Phase 4).
  mode: 'balanced',

  // Extension UI language: 'auto' = follow SillyTavern (localStorage['language']),
  // 'en' / 'ru' = forced. Read in i18n.js (getLang). UI only; never touches prompts.
  uiLanguage: 'auto',

  // --- Two-model architecture ---
  // Empty string = use ST's current active connection.
  // Otherwise — the ST Connection Profile name used by the BACKGROUND agent
  // (gathering info, picking branches, updating the buffer). The main reply
  // always goes through the user's normal model — we don't touch it.
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

  // --- Auto-lorebook ---
  // Ask on first use in a chat with no book (pick/create/cancel).
  askOnFirstUse: true,
  lorebookNameTemplate: '🌀 {{char}} — {{chat}}',

  // --- Agent / retrieval ---
  // 'recency' = cheap 🟢 fallback (recency + keywords, no LLM).
  // 'agent'   = 🟡 scout agent picks branches and tree depth.
  retrievalMode: 'recency',
  // Ceiling: wake the agent at least once per N turns (scene detector may fire more often).
  agentEveryNTurns: 3,

  // --- Scene detector (🟢, no LLM) ---
  sceneDetector: {
    algo: 'adaptive',    // 'adaptive' = IDF-cosine + online z-threshold + CUSUM; 'legacy' = old Jaccard + fixed threshold
    sensitivity: 0.5,    // 0 = rarely treat as a shift, 1 = aggressive (in adaptive, maps to z-threshold k=2−sens·1.5)
    newWordRatio: 0.5,   // (legacy/warmup) share of new words in window → dynamic agent throttling
    maxTurnsCap: 8,      // never-starve: wake at least once per N turns even in a static scene
    ewmaAlpha: 0.2,      // adaptive: EWMA coefficient for online mean/variance of dissimilarity (~5-turn window)
    cusumSlack: 0.5,     // adaptive: κ — CUSUM "dead zone" in units of σ (damps minor noise)
    cusumThreshold: 5,   // adaptive: h — CUSUM accumulator threshold in units of σ (sustained shift)
    warmupTurns: 4,      // adaptive: first N turns run legacy while statistics accumulate
  },

  // --- Thought buffer ---
  thoughtBuffer: {
    enabled: true,
    limitEnabled: true,   // whether to cap buffer size (user's choice)
    maxItems: 7,          // size cap when limitEnabled (anti-loop)
    maxConstants: 3,      // separate cap on "constant" items so they don't crowd out regular thoughts
    decayPerTurn: 1,      // how much an unconfirmed item's weight drops per turn
    dropThreshold: 0,     // weight <= threshold → item drops out of the buffer
    startWeight: 5,       // weight of a new/confirmed item
  },

  // --- Favorites / saved clips ---
  favorites: {
    enabled: true,
    maxInContext: 8,      // max permanent items to inject
  },

  // --- Quotes (parts of messages) ---
  quotes: {
    defaultMode: 'chance', // new-quote mode: permanent|chance|relevant
  },

  // --- Memory resurfacing ---
  // Occasionally a pinned clip resurfaces near the end of context as a
  // "memory". In v1 the cheap AI adds a "how this fits" line.
  resurfacing: {
    enabled: false,       // off by default (randomness breaks immersion)
    chance: 0.15,         // resurface probability per turn
    depth: 4,             // injection depth (near recent messages: 3-4)
  },

  // --- UI ---
  slashPrefix: 'cl',

  // ============ Phase A — foundation ============
  // Background worker (job-queue). enabled=false → background jobs don't run
  // (buffer/favorites/retrieval still work without it).
  autonomous: {
    enabled: false,        // turned on when the user is ready for auto-memory
    arcCapMessages: 40,    // mirrors arc.capMessages for the mode preset
    concurrency: 1,        // 1-2 parallel jobs
    callsPerHour: 30,      // budget cap on paid LLM calls
  },

  // Auto-hide old messages by arc slab (keeps the active window small).
  autoHide: {
    enabled: true,
    windowSize: 12,        // "live window": how many recent messages stay ALWAYS visible (default-window)
    bySlab: true,          // hide a whole arc, not one at a time
    keepTailFromSlab: 2,   // bridge: keep N messages of the newest hidden slab
    afterSummary: true,    // hide an arc ONLY once it has a summaryGist (safe hiding)
    scope: 'slab',         // 'slab' = hide the whole summarized slab · 'newest' = only the newest
  },

  // Arc segmentation.
  arc: {
    capMessages: 40,       // arc length in messages before sealing
    useMarkers: true,      // explicit /cl-arc command as a boundary
    useSceneBreaks: false, // drawn separators (---, ***, timeskip) as a boundary (off by default)
    minMessages: 6,        // a marker won't seal an arc shorter than this (anti short-arcs)
    useStoryTime: false,   // in-story time as a boundary (optional)
    editDirtyThreshold: 0.10, // < this share of changed words → typo, arc not marked
  },

  // Catch-up backfill for chats enabled late (offer auto-clears once memory grows
  // forward or backfill runs).
  backfill: {
    threshold: 10,         // chat length above which a one-time backfill is offered
  },

  // Lorebook backups.
  backup: {
    enabled: true,
    keepCount: 8,          // rolling: how many snapshots to keep
    safetyBeforeOps: true, // snapshot before a risky auto-operation
  },

  // ============ Phase B — relationship graph + memory tiers ============
  // Extraction (arc summary + triples). Runs ONLY when autonomous.enabled
  // (paid LLM calls go through job-queue, off the critical path).
  extraction: {
    enabled: true,         // master toggle for the extraction pipeline
  },

  // ============ Phase C — deep extraction (significance + drift) ============
  // Extra pass over arc-summary: STRICT triple allow-list (anti-hallucination),
  // arc significance scoring (auto-pin/deprioritize) and a cheap drift flag.
  // Runs only when autonomous.enabled; off the critical path (job-queue).
  deepExtract: {
    enabled: false,        // turned on in autonomous (master toggle for the extra pass)
    llmMode: 'hybrid',     // 'code' = 0 LLM · 'hybrid' = code + cheap AI on ambiguous drift · 'full' = LLM pass
    pinThreshold: 0.7,     // significance ≥ → auto-pin arc (tier=pinned)
    lowThreshold: 0.3,     // significance < → "filler" (fades faster in recollection); internal
  },

  // Drift monitor: cheap per-arc flag (counter-link vs established edge) +
  // expensive cross-arc audit of the whole graph (Phase D, autonomous only).
  drift: {
    cheapEnabled: true,         // compute the cheap drift flag on arc seal
    sensitivity: 0.5,           // 0 = rarely flag, 1 = aggressive
    auditEnabled: true,         // periodic expensive audit (ONE LLM pass; autonomous only)
    auditEveryNMessages: 500,   // ~once per N settled turns → enqueue 'audit-expensive'
  },

  // Tier 2 — "recollections": condensed gists of sealed arcs + voiceQuotes.
  recollection: {
    enabled: true,
    maxGists: 12,          // how many active gists to keep (old ones fade)
    voiceQuotesPerArc: 3,  // verbatim lines per arc (preserve character voice)
    budget: 500,           // token ceiling for tier 2 injection
  },

  // Tier 3 — relationship graph (nodes/edges in the book's manifest entry).
  graph: {
    enabled: true,
    maxNodes: 40,          // soft node ceiling (archiveCold prunes cold ones)
    subgraphHops: 2,       // BFS depth around scene entities (ego-graph)
    budget: 1500,          // token ceiling for subgraph injection
    archiveColdAfterArcs: 8, // node idle for N arcs → archived (out of injection)
  },

  // Where (depth) to place tier injection blocks. Defaults are sensible; on a
  // conflict with Author's Note/Summarize the user adjusts.
  placement: {
    depthRecollection: 4,
    depthGraph: 5,
  },

  // ============ Phase D — context budget ============
  // One hard token ceiling over ALL memory injection (buffer+favorites+gists+
  // graph+ToC). Fills by tier priority; on overflow → condense (drops whole lines,
  // never mid-sentence), lowest tiers drop first. Pure code, no LLM. Off → each tier
  // is trimmed by its own budget as before (no global cap).
  contextBudget: {
    enabled: false,        // master toggle for the global ceiling
    target: 3000,          // token ceiling for the whole "memory bundle"
    autoReview: true,      // auto-highlight "Review" when the budget is full
  },

  // ============ Phase D — two-stage pipeline §4b (Stage-1 "memory engine") ============
  // The cheap model assembles the memory core (gists+subgraph+retrieval) and hands the
  // expensive side (= ST's native generation) only a distillate. This is Stage-1 only —
  // Stage-2 (the writer) is ST itself. Per-scene core cache (no rebuild on static scenes)
  // + optional Compose pass. Off → injection behaves like v0.9.0 (fresh build, no cache/compose).
  pipeline: {
    enabled: false,        // scene-gated memory engine + core cache (turned on in autonomous)
    composeLLM: false,     // call 2: Compose/Compress with cheap AI (else code compression). Optional.
  },

  // ============ Phase D — activity feed ============
  // Visible local feed of background actions (arc seals, extraction, graph merges,
  // drift, audits). Pure bookkeeping: NO LLM, NO lorebook writes, doesn't touch
  // injection. ON by default (the whole point is transparency). Stored per-chat.
  activityLog: {
    enabled: true,         // record background actions (no LLM, local)
    maxEntries: 100,       // rolling ceiling; oldest drop first
  },

  // --- Timeline (timeline.js, Phase D) ---
  // One chronology in Memory → Timeline: activity events + restore points (backup.js
  // snapshots) with a ⏪ Restore button. UI only, doesn't touch injection; which rows
  // to show is decided by activityLog.enabled / backup.enabled.
  timeline: {
    enabled: true,         // show the Timeline section (UI master toggle)
  },

  // --- Chat fork (branch-guard) ---
  // On a chat branch ST copies the book binding into the branch → timelines share one
  // book. We offer to give the branch its own copy so memory doesn't cross over.
  branch: {
    enabled: true,
    askOnFork: true,            // ask on entering a branch (else use defaultAction)
    defaultAction: 'fork',      // 'fork' = own book · 'share' = share with parent
    _handled: [],               // internal: branch ids already decided (rolling)
  },

  // --- Global book (global-reconciler) ---
  // If the book the current chat writes to is GLOBALLY active (selected_world_info),
  // the chat's memory leaks into all chats. We offer a private copy or removing it from global.
  globalReconciler: {
    enabled: true,
    askOnDetected: true,        // ask when our book is globally active
    defaultAction: 'copy',      // 'copy' = private copy · 'disable' = remove from global · 'share' = keep
    _handled: [],               // internal: chatIds already decided (rolling)
  },

  // --- Diagnostics (debug-trace, testing branch) ---
  // Ring trace of decisions (arc seals, scene shifts, agent requests, buffer writes)
  // + a button to export a state snapshot as JSON. Off → trace() is a no-op.
  debug: {
    enabled: false,        // record the decision trace (in memory; no behaviour change)
    traceCap: 500,         // how many recent events to keep
  },
});

export function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(DEFAULTS);
  }
  // Shallow merge plus one level of nested objects against the defaults.
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

/**
 * Single contract "cheap background jobs run everywhere except lite": arc summaries,
 * graph merges, auto-hide after summary. Expensive ones (audit / deep-extract) are
 * gated separately by autonomous.enabled at their call sites. One source of truth so
 * adding a mode or a "pause background memory" toggle is a one-place change.
 */
export function backgroundJobsAllowed(s = getSettings()) { return s.mode !== 'lite'; }

/** Apply a mode preset to the rest of the settings (anti UI-overload). */
export function applyMode(mode) {
  const s = getSettings();
  s.mode = mode;
  if (mode === 'lite') {
    s.retrievalMode = 'recency';          // no background LLM
    s.resurfacing.enabled = false;
    s.autonomous.enabled = false;         // background worker off
    s.contextBudget.enabled = false;      // no managed memory — no ceiling
  } else if (mode === 'balanced') {
    s.retrievalMode = 'agent';
    s.agentEveryNTurns = 3;
    s.autonomous.enabled = false;         // CHEAP background jobs (arc summary + graph merge) run,
                                          // and auto-hide after summary too; EXPENSIVE ones (audit/
                                          // deep-extract) stay autonomous-only.
    s.contextBudget.enabled = true;       // Phase D: the ceiling is pure code, no LLM → safe to enable
  } else if (mode === 'autonomous') {
    s.retrievalMode = 'agent';
    s.agentEveryNTurns = 2;
    s.autonomous.enabled = true;          // Phase A foundation in place → enable the worker
    // Phase B: the extraction pipeline (arc summary + graph merge) runs only when
    // autonomous.enabled. Tier 2/3 injection (gists/subgraph) needs NO LLM and runs in
    // every mode if data already exists in memory.
    s.extraction.enabled = true;
    // Phase C: the deep-extraction pass (allow-list + significance + drift) is also
    // autonomous-only. Keep llmMode as the user chose (default hybrid).
    s.deepExtract.enabled = true;
    // Phase D: global injection ceiling (pure code) — all the more so for full memory.
    s.contextBudget.enabled = true;
    // Phase D §4b: two-stage pipeline — scene-gated memory engine + core cache.
    // composeLLM (extra cheap call on scene shift) is left to the user — default off.
    s.pipeline.enabled = true;
  }
  saveSettings();
  return s;
}
