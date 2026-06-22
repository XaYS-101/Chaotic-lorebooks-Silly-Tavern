[English](README.md) | [Русский](README_ru.md)

# 🌀 Chaotic Lorebooks

An **active memory** extension for SillyTavern. It gives your character a working
memory and a self-maintained lorebook, so long chats stay coherent without you
hand-managing World Info. Runs on any model — no tool-calling required, no server,
no secrets stored in the client.

* * *

## In short

You roleplay as usual. In the background the extension:

- watches the chat and groups it into **arcs** (episodes),
- **summarizes** each arc once it's settled and pulls out who-relates-to-whom,
- keeps a small **knowledge graph** and a decaying **thought buffer**,
- and injects only the **relevant slice** of all that before each reply — within a
  token budget you control.

The result: the model remembers what matters across hundreds of messages while the
prompt stays small. Everything it learns is written into an ordinary lorebook, so
it keeps working even with the extension turned off.

* * *

## Pick a mode — that's most of the setup

Open **Extensions → Chaotic Lorebooks** and choose a **Mode**. Each mode is a preset
that flips the right toggles for you:

- **Lite** — fully local, **zero extra LLM calls**. Thought buffer + favorites +
  recency retrieval. Instant and free; good for weak setups or quick chats.
- **Balanced** *(default)* — adds **scene-aware retrieval** (a cheap background pass
  every few turns) and the **context budget**. Arcs and auto-hide run; no heavy paid
  extraction.
- **Autonomous** — the **full pipeline**: summarizes every arc, deep-extracts
  relationships/goals, merges the knowledge graph, and runs an occasional cross-arc
  **drift audit**. The character maintains its own memory end-to-end.

Everything degrades gracefully: if no LLM/profile is available, the agent layer
falls back to the cheap local retrieval and the chat is never blocked.

* * *

## Features in detail

### 1. Automatic standalone lorebook
The first time you generate in a chat with no book bound, you get a popup: **use an
existing book / create a new one / cancel**. The new book is named from a template
(`{{char}}` / `{{user}}` / `{{chat}}`) and bound to the chat via SillyTavern's own
native `world_info` metadata, so the engine activates it like any normal lorebook.

### 2. Four-tier memory
Memory is layered so the right thing lives at the right cost:

| Tier | Role | Lives in |
|---|---|---|
| 1 — Thought buffer | live working memory (goals, traits, threads) | chat metadata |
| 2 — Recollections | one-line gists + links into the graph | metadata + book |
| 3 — Knowledge graph | full entities & typed relations, on demand | book (manifest entry) |
| 4 — Pinned / foundation | permanent facts (identity, "how we met") | book (pinned keys) |

Forgetting is a toggle, not a delete: gists flip to inactive (natural decay, a manual
switch, or bulk by arc) and can always be switched back on.

### 3. Arcs & auto-hide — the engine
The chat is segmented into arcs by explicit markers (`/cl-arc`, scene-break regex) and
a length cap. When an arc settles it's sealed **once**, summarized, and the matured
slab of old messages is **auto-hidden** (flagged, never deleted) to keep the live
window small — which is the real lever on prompt size. A safety gate only hides
messages **after** they're captured into memory, never the live tail (swipes/edits) or
pinned ones. Reversible any time via **Reveal hidden** or `/cl-reveal`.

### 4. Knowledge graph & active retrieval
Instead of folders, the model sees relations: `Sable —trusts→ Ren (6/10, since arc 3)`.
A background **scout** reads the current scene, picks which branches and how deep to
pull, and **explains why** — that reasoning is injected alongside the data, so the
model uses it better. Cheap path (`recency`) needs no LLM; agent path is throttled
(`agentEveryNTurns`).

### 5. Two-model routing
Background memory work runs on a **Connection Profile** you choose (a cheap/fast
model), while your normal model writes the actual reply. Keys stay in SillyTavern's
storage — the extension never holds secrets. Leave the profile empty to reuse the
current connection.

### 6. Favorites, quotes & resurfacing (★)
Click the **★** on any message to make the model emphasize it; select text first to
save just that **quote**. The **💾 Saved** tab is an editor: edit text, toggle
inject on/off (👁), pin to the permanent tier (📌), promote to a lorebook entry (📚),
or delete (✕). Occasionally a relevant saved memory **resurfaces** on its own for
callbacks and liveliness.

### 7. The memory drawer
A mobile-first slide-out (wand menu → **🌀 Chaotic Lorebooks**, or `/cl-tree`) with
three tabs:

- **🧠 Memory** — recollections, the lorebook tree, arcs, drift flags, timeline, and
  the budget meter; add author notes that the model reads as tree nodes.
- **💾 Saved** — favorites & quotes (filter chips).
- **💭 Thoughts** — the live thought buffer.

### 8. Context budget
Keeps the injected memory under a target you set (counted with SillyTavern's tokenizer).
Instead of blunt truncation, a cheap pass **condenses or relocates** detail
(active → gist → graph) so meaning survives. Buttons **Tighten** and **Review** (plus
auto-review) let the model decide what to let go into deeper layers. Can be turned off.

### 9. Drift monitoring
Compares the character's baseline (from the card) against its current portrayal. Fast,
large deltas raise a **soft flag** in the UI — never an auto-correction. Natural
evolution is allowed; the occasional expensive cross-arc audit (autonomous only) catches
drift the cheap pass missed.

### 10. Timeline, backups & activity log
Sealing an arc takes a rolling **snapshot** of the bound book (restore from the
timeline). The **activity log** is a transparent feed of what was sealed / extracted /
merged / forgotten and why, with timestamps.

### 11. Safety nets — branch & global isolation
- **Branch guard:** when you fork a chat, the branch would otherwise share the parent's
  book. The extension offers to **fork the book** so timelines don't bleed into each other.
- **Global reconciler:** if the book you're writing to is also active **globally** (across
  all chats), it offers to keep a **private copy** for this chat or remove it from the
  global set — your call, behind a confirm popup.

### 12. Slash commands · i18n · mobile
- `/cl-tree` — open the memory drawer · `/cl-buffer` — decay tick + open ·
  `/cl-arc` — seal the open arc now · `/cl-reveal` — un-hide all auto-hidden messages.
- **EN/RU** UI that follows SillyTavern's language, with an explicit override
  (Auto / English / Русский) in settings.
- Mobile-first: large tap targets, theme colors only, ≤3 drawer tabs to avoid overload.

* * *

## Installation

SillyTavern → **Extensions → Install Extension** → paste this repository's URL.
Or manually: drop the folder into `data/<your-user>/extensions/` and refresh ST.

* * *

## Your chats are safe

This is a core design rule, not an afterthought:

- **Your messages are never modified.** Memory is injected only at generation time — it
  is *not* written back into the chat. Delete the extension and every message is exactly
  as you left it.
- **Your memory survives uninstall.** It lives in **standalone World Info books** —
  ordinary SillyTavern files that keep working as normal lorebooks afterward. The
  chat → book link uses ST's native `world_info` key, so the book stays attached.
- **Your manual edits win.** All writes go through a single mutex'd queue with origin
  tags; anything you edit by hand is marked `user` and never auto-overwritten. Nothing
  is auto-deleted, and every destructive action is behind a confirm popup.
- The knowledge graph is **one disabled entry**, so it never injects on its own.
- *One nuance:* if you used **auto-hide**, those messages keep ST's `is_system` flag
  after uninstall (still collapsed) — reversible via ST's own unhide.

* * *

## Known limitations & quirks

- **Background features need a model.** Summaries, extraction, and the scout run via a
  Connection Profile. Without one, the extension degrades to local recency retrieval —
  it won't crash, it just gets simpler.
- **Memory builds forward.** Opening a long, pre-existing chat does **not** retroactively
  digest its history; memory accrues from where you are. (Per-generation cost is the same
  whether the chat is 100 or 2000 messages — the interceptor doesn't rescan.)
- **LLM extraction isn't perfect.** Summaries and relations can be approximate. That's
  what the drawer is for — edit, forget, pin, or restore from a snapshot.
- **Autonomous mode costs calls.** They're throttled (≤2 concurrent, an hourly budget
  cap) and run off the hot path, never blocking your reply.
- **It's information-dense on mobile.** The drawer is mobile-first, but it surfaces a lot.

* * *

## License

AGPL-3.0 (following the TunnelVision / MemoryBooks lineage).
