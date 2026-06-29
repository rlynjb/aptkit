# Context Engineering

**Industry term:** context engineering (curating everything the model sees at inference). *Industry standard.*

## Zoom out, then zoom in

The discipline RAG and prompt engineering are subsets of: everything the model sees at inference time, deliberately curated. aptkit's clearest instance is `injectProfile` — composing a user profile into the system prompt before rendering.

```
  Zoom out — context engineering is the superset over the whole input

  ┌─ Context engineering (the discipline) ──────────────────────┐
  │  ┌─ prompt ─┐ ┌─ RAG ─┐ ┌─ memory ─┐ ┌─ tool outputs ─┐     │ ← we are here
  │  │ template │ │chunks │ │ recall   │ │ search results │     │
  │  └──────────┘ └───────┘ └──────────┘ └────────────────┘     │
  │  ┌─ profile (injectProfile) ─┐ ┌─ message history ─┐         │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit assembles a system prompt from parts — a profile (`injectProfile`, `packages/context/src/profile-injector.ts`), a prompt template (`renderPromptTemplate`), and the retrieved chunks the agent pulls at runtime. Context engineering is the discipline of deciding *what* goes in the window and *in what order*.

## The structure pass

**Layers.** The window's contents as bands: system prompt (profile + template) at the top, message history, tool outputs accumulating during the run.

**Axis: cost/quality — what fills the window for the next step?** Every token in the window costs money and risks lost-in-the-middle; the job is curation.

**The seam.** The boundary between *static* context (profile, template — set once) and *dynamic* context (retrieved chunks, tool results — grow per turn). aptkit assembles the static part before the loop and lets the loop accumulate the dynamic part.

## How it works

**Use case in aptkit:** the rag-query agent personalizing answers. The reader's profile (me.md-style text) is injected so the assistant knows who it's helping, before any retrieval happens.

### Move 1 — the mental model

It's component composition for the prompt. You build a React view by composing `<Header/>`, `<Body/>`, `<Footer/>` in order; you build a context window by composing profile + template + history + tool outputs in order. The order and the budget are the design.

```
  Context window assembly (rag-query)

  ┌─ system ────────────────────────────────────────┐
  │  [profile]   ← injectProfile, position: 'start'  │
  │  [template]  ← "call search first, cite sources" │
  └──────────────────────────────────────────────────┘
  ┌─ messages (grows per turn) ─────────────────────┐
  │  user question → assistant tool_use → tool_result│
  └──────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**`injectProfile` is pure string composition — and the order is deliberate.** It prepends the profile to the template, then `renderPromptTemplate` resolves placeholders:

```ts
// rag-query-agent.ts:54 — C then render: inject profile, then resolve placeholders
const withProfile = options.profile
  ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
  : template;
this.system = renderPromptTemplate(withProfile, {});
```

The profile goes at the `start` (`profile-injector.ts:35`) so the model reads *who it's helping* before *what to do*. And injection happens *before* rendering, so the template's `{placeholder}`s survive (`profile-injector.ts:13`) — the two steps compose without fighting.

**Why this is context engineering, not prompt engineering.** Prompt engineering is wording the template well. Context engineering is deciding the profile belongs in the window at all, where it sits relative to the instructions, and that it's injected before rendering so both survive. The wording is one band; the assembly is the discipline.

**The dynamic half: retrieved chunks.** During the loop, `search_knowledge_base` results enter the window as tool-result messages. That's context too — and the `minTopK` floor / tolerant filter ([../02-agentic-retrieval/01-agentic-rag.md](../02-agentic-retrieval/01-agentic-rag.md)) plus the 16k-char tool-result truncation (`run-agent-loop.ts:52`) are context-engineering controls: they bound *how much* retrieved context fills the window, so a flood of chunks can't push the instructions out.

**The reframe.** Most agent failures are context failures, not model failures — stale retrieval, lost-in-the-middle on a bloated window, no user state loaded, the wrong tool outputs present. Bigger context windows don't fix this; they make room for more noise. aptkit's truncation cap and retrieval floors are the curation that keeps the window's signal-to-noise high.

### Move 3 — the principle

Prompt engineering gets the first good output; context engineering keeps the thousandth good. The job is curating what fills the window for the *next* step — and, in a multi-agent system, *which agent sees what* ([../03-multi-agent-orchestration/08-shared-state-and-message-passing.md](../03-multi-agent-orchestration/08-shared-state-and-message-passing.md)). aptkit's profile injection plus retrieval/truncation caps are that curation in single-agent form.

## Primary diagram

```
  Context engineering in rag-query — static + dynamic bands

  STATIC (assembled once, before the loop):
    injectProfile(template, profile, {start}) → renderPromptTemplate
    = [profile heading + profile] + [instructions]

  DYNAMIC (accumulates in the loop, bounded):
    + tool_result chunks  (capped: minTopK floor, 16k truncation)
    + message history

  → the window = curated assembly, not "everything available"
```

## Elaborate

Context engineering is the reframe the field landed on after "prompt engineering" turned out to be too narrow — the prompt is one input among many, and the failures were coming from the *other* inputs (stale RAG, bloated history, missing user state). The discipline is treating the whole window as something you compose and budget, not something you fill. aptkit embodies it modestly: `injectProfile` composes the static part deliberately, and the retrieval floors plus truncation cap budget the dynamic part. The multi-agent extension — context routing, per-agent windows — is the same discipline at a larger scope.

## Interview defense

**Q: What's the difference between prompt engineering and context engineering here?**

Prompt engineering is wording the template. Context engineering is the assembly: aptkit injects the user profile at the *start* of the system prompt (so the model reads who it's helping before its instructions), does it *before* template rendering (so both survive), and bounds the dynamic context — retrieved chunks — with a `minTopK` floor and a 16k truncation cap so a flood of chunks can't push the instructions out of the window.

```
  prompt eng:   word the template well       (one band)
  context eng:  compose + order + budget all bands  (the discipline)
```

*Anchor: most agent failures are context failures; bigger windows make room for more noise, not less.*

## See also

- [02-agent-memory-tiers.md](02-agent-memory-tiers.md) — memory as another context band.
- [../02-agentic-retrieval/01-agentic-rag.md](../02-agentic-retrieval/01-agentic-rag.md) — retrieved chunks as dynamic context.
- Context-window and lost-in-the-middle mechanics: `.aipe/study-ai-engineering/`.
- Prompt template construction: `.aipe/study-prompt-engineering/`.
