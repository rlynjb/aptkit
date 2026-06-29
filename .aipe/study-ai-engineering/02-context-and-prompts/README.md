# 02 — Context and prompts

> Anchor: LLM application engineering. · Curriculum: Phase 2 (no curriculum file
> in this repo; exercises cite real aptkit/buffr paths instead).

The model is a function with a fixed-size input slot. Everything in this
sub-section is about that slot: how big it is, how the model reads what's inside
it, and how you assemble what goes in. Three concepts, three different failure
modes.

You've shipped UIs — you already think about fixed-size containers (a viewport,
a scroll buffer, a render pipeline). That intuition transfers directly. The
window is a buffer; lost-in-the-middle is "users only read the top and bottom of
a list"; prompt chaining is composing pure functions. The new part is that the
consumer is a probabilistic model, not a deterministic renderer.

## Files (self-contained per concept)

1. `01-context-window.md` — the window as a fixed token budget; aptkit's
   GUARD-don't-truncate approach (`ContextWindowExceededError`) plus tool-result
   truncation in the agent loop. Bridge: a fixed-size buffer / a `div` with
   `overflow`.
2. `02-lost-in-the-middle.md` — models attend to the start and end, miss the
   middle; aptkit's lever is retrieve-few-rank-well (top-k cosine). Reranking by
   position is `not yet exercised`. Bridge: a long list where you only read the
   top and the bottom.
3. `03-prompt-chaining.md` — the analytics pipeline:
   monitoring → diagnostic → recommendation; one job per step; prompt packages
   plus `renderPromptTemplate`. Bridge: composing pure functions / a render
   pipeline.
