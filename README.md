[English](README.md) | [Русский](README_ru.md)

# 🌀 Chaotic Lorebooks

An **active memory** extension for SillyTavern. It gives your character a real
working memory and a lorebook that maintains itself, so long chats stay coherent
and you stop babysitting World Info by hand. It runs on any model. No tool-calling,
no server, and nothing secret kept in the browser.

* * *

## In short

You roleplay like normal. In the background, the extension:

- watches the chat and groups it into **arcs** (episodes),
- **summarizes** each arc once it settles and works out who relates to whom,
- keeps a small **knowledge graph** and a **thought buffer** that fades over time,
- and before each reply, injects only the **relevant slice** of all that, inside a
  token budget you set.

So the model remembers what matters across hundreds of messages, and the prompt
still stays small. Everything it learns gets written into an ordinary lorebook, which
means it keeps working even with the extension switched off.

* * *

## Pick a mode, and that's most of the setup

Open **Extensions → Chaotic Lorebooks** and choose a **Mode**. Each one is a preset
that flips the right toggles for you:

- **Lite.** Fully local, with zero extra LLM calls. You get the thought buffer,
  favorites, and recency retrieval. It's instant and free, which makes it a good fit
  for weak setups or quick chats.
- **Balanced** *(default).* Adds **scene-aware retrieval** (a cheap background pass
  every few turns) and the **context budget**. Arcs and auto-hide run. No heavy paid
  extraction.
- **Autonomous.** The whole pipeline. It summarizes every arc, deep-extracts
  relationships and goals, merges the knowledge graph, and runs the occasional
  cross-arc **drift audit**. The character maintains its own memory from end to end.

Everything degrades gently. If there's no LLM or profile available, the agent layer
falls back to cheap local retrieval and the chat is never blocked.

### What each mode includes

| Capability | Lite | Balanced | Autonomous |
|---|---|---|---|
| Thought buffer (incl. goals) | ✅ | ✅ | ✅ |
| Favorites & quotes (★) | ✅ | ✅ | ✅ |
| Recency retrieval (ToC) | ✅ | ✅ | ✅ |
| Arc sealing (cap / marker) | ✅ | ✅ | ✅ |
| Auto-hide with per-arc keepTail | ✅ immediate | ✅ after summary | ✅ after summary |
| Agentic scout retrieval (LLM) | ❌ | ✅ every ~3 turns | ✅ every ~2 turns |
| Arc summarization (LLM) | ❌ | ✅ cheap | ✅ |
| Goals fed into summarization | ❌ | ✅ | ✅ |
| Knowledge graph (triple merge) | ❌ | ✅ | ✅ |
| Recollections (arc gists) | ❌ | ✅ | ✅ |
| Context budget ceiling | ❌ | ✅ | ✅ |
| Deep-extract (anti-hallucination, significance) | ❌ | ❌ | ✅ |
| Cross-arc drift audit | ❌ | ❌ | ✅ |
| Two-stage pipeline cache | ❌ | ❌ | ✅ |
| Background LLM cost | none | low (scout + arc summary) | ~30/hr, throttled |

Slash commands, favorites, the memory drawer, backups, and the branch/global
safety nets work in **every** mode.

* * *

## Features in detail

### 1. Automatic standalone lorebook
The first time you generate in a chat with no book bound, you get a popup: **use an
existing book, create a new one, or cancel**. A new book is named from a template
(`{{char}}` / `{{user}}` / `{{chat}}`) and bound to the chat through SillyTavern's own
native `world_info` metadata, so the engine activates it like any normal lorebook.

### 2. Four-tier memory
Memory is layered so the right thing lives at the right cost:

| Tier | Role | Lives in |
|---|---|---|
| 1. Thought buffer | live working memory (goals, traits, threads) | chat metadata |
| 2. Recollections | one-line gists + links into the graph | metadata + book |
| 3. Knowledge graph | full entities & typed relations, on demand | book (manifest entry) |
| 4. Pinned / foundation | permanent facts (identity, "how we met") | book (pinned keys) |

Forgetting is a toggle, not a delete. Gists flip to inactive, whether by natural
decay, a manual switch, or in bulk by arc, and you can always switch them back on.

### 3. Arcs & auto-hide: the engine
The chat is cut into arcs by explicit markers (`/cl-arc`, a scene-break regex) and a
length cap. When an arc settles, it gets sealed **once**, summarized, and the matured
slab of old messages is **auto-hidden** (flagged, never deleted) to keep the live
window small. That window size is the real lever on prompt size. A safety gate only
hides messages **after** they're captured into memory, so it never touches the live
tail (swipes and edits) or anything pinned. You can undo it any time with **Reveal
hidden** or `/cl-reveal`.

Hiding is **gradual**, not all-or-nothing. Each hidden arc keeps its **last few
messages visible** (a `keepTail`, default 2), forming a bridge into the next arc, and
in place of the hidden bulk the model sees the arc's **gist** plus a couple of verbatim
**quotes**, so the thread never snaps.

### 4. Knowledge graph & active retrieval
Instead of folders, the model sees relations: `Sable —trusts→ Ren (6/10, since arc 3)`.
A background **scout** reads the current scene, decides which branches to pull and how
deep, and **says why**. That reasoning gets injected next to the data, so the model
puts it to better use. The cheap path (`recency`) needs no LLM; the agent path is
throttled (`agentEveryNTurns`).

### 5. Two-model routing
Background memory work runs on a **Connection Profile** you pick (some cheap, fast
model), while your normal model writes the actual reply. Keys stay in SillyTavern's
storage, so the extension never holds a secret of its own. Leave the profile empty to
reuse the current connection.

### 6. Favorites, quotes & resurfacing (★)
Click the **★** on any message to make the model lean on it. Select text first and it
saves just that **quote**. The **💾 Saved** tab is a small editor: edit the text,
toggle injection on or off (👁), pin to the permanent tier (📌), promote to a lorebook
entry (📚), or delete (✕). Every so often a relevant saved memory **resurfaces** on
its own, which is what makes callbacks happen.

### 7. The memory drawer
A mobile-first slide-out (wand menu → **🌀 Chaotic Lorebooks**, or `/cl-tree`) with
three tabs:

- **🧠 Memory**: recollections, the lorebook tree, arcs, drift flags, the timeline,
  and the budget meter. You can also add author notes here that the model reads as
  tree nodes.
- **💾 Saved**: favorites and quotes (with filter chips).
- **💭 Thoughts**: the live thought buffer.

### 8. Context budget
Keeps the injected memory under a target you set, counted with SillyTavern's own
tokenizer. Rather than chop text off blunt, a cheap pass **condenses or relocates** the
detail (active → gist → graph) so the meaning survives the move. **Tighten** and
**Review** (plus auto-review) hand the model the call on what to let slide into deeper
layers. You can turn the whole thing off.

### 9. Drift monitoring
Compares the character's baseline (from the card) against how it's being played now.
Fast, large deltas raise a **soft flag** in the UI, and that's all they do. It never
auto-corrects. Natural evolution is fine; the occasional expensive cross-arc audit
(autonomous only) catches the drift the cheap pass missed.

### 10. Timeline, backups & activity log
Sealing an arc takes a rolling **snapshot** of the bound book, and you restore from the
timeline. The **activity log** is a plain feed of what got sealed, extracted, merged,
or forgotten, why, and when.

### 11. Safety nets: branch & global isolation
- **Branch guard.** Fork a chat and the branch would otherwise share the parent's book.
  The extension offers to **fork the book** too, so the two timelines don't bleed into
  each other.
- **Global reconciler.** If the book you're writing to is also active **globally**
  (across every chat), it offers to keep a **private copy** for this chat, or to drop it
  from the global set. Your call, behind a confirm popup.

### 12. Slash commands · i18n · mobile
- `/cl-tree` opens the memory drawer. `/cl-buffer` runs a decay tick and opens it.
  `/cl-arc` seals the open arc now. `/cl-reveal` un-hides every auto-hidden message.
- **EN/RU** UI that follows SillyTavern's language, with an explicit override
  (Auto / English / Русский) in settings.
- Mobile-first: big tap targets, theme colors only, and no more than three drawer tabs
  so it doesn't get crowded.

* * *

## Installation

SillyTavern → **Extensions → Install Extension** → paste this repository's URL.
Or do it by hand: drop the folder into `data/<your-user>/extensions/` and refresh ST.

* * *

## Your chats are safe

This is a core design rule, not an afterthought:

- **Your messages are never modified.** Memory is injected only at generation time. It
  is *not* written back into the chat. Delete the extension and every message is exactly
  where you left it.
- **Your memory survives uninstall.** It lives in **standalone World Info books**,
  which are ordinary SillyTavern files that keep working as normal lorebooks afterward.
  The chat-to-book link uses ST's native `world_info` key, so the book stays attached.
- **Your manual edits win.** All writes go through a single mutex'd queue with origin
  tags. Anything you edit by hand is marked `user` and never auto-overwritten. Nothing
  is auto-deleted, and every destructive action sits behind a confirm popup.
- The knowledge graph is **one disabled entry**, so it never injects on its own.
- *One nuance:* if you used **auto-hide**, those messages keep ST's `is_system` flag
  after uninstall (still collapsed). ST's own unhide reverses it.

* * *

## Known limitations & quirks

- **Background features need a model.** Summaries, extraction, and the scout all run
  through a Connection Profile. Without one, the extension drops down to local recency
  retrieval. It won't crash, it just gets simpler.
- **Memory builds forward.** Open a long, pre-existing chat and it does **not** go back
  and digest the history. Memory accrues from wherever you are. (Per-generation cost is
  the same whether the chat is 100 messages or 2000, because the interceptor doesn't
  rescan.)
- **LLM extraction isn't perfect.** Summaries and relations can come out approximate.
  That's what the drawer is for: edit, forget, pin, or restore from a snapshot.
- **Autonomous mode costs calls.** They're throttled (two at a time at most, with an
  hourly budget cap) and they run off the hot path, so they never block your reply.
- **It's dense on mobile.** The drawer is mobile-first, but it does surface a lot at once.
- **Don't rename the extension folder.** The prompt interceptor is bound by a fixed
  global name in `manifest.json`; renaming the folder can silently break context
  injection (a console warning is logged if the name no longer matches).
- **Custom endpoint keys are stored in plain text.** If you use a self-contained custom
  endpoint instead of an ST Connection Profile, its API key sits unencrypted in
  SillyTavern's settings, like any client-side extension. Prefer a Connection Profile
  where you can.

* * *

## License

AGPL-3.0 (following the TunnelVision / MemoryBooks lineage).
