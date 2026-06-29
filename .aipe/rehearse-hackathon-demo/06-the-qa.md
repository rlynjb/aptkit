# Chapter 6 — The Q&A   (prep only — runs after the clock)

## Opening hook

This chapter never eats your ten minutes. It runs *after* the timed
slot, when a judge leans forward and starts probing. The clock is off;
what matters now is that every answer is crisp, honest, and anchored
to something real in the repo. The fastest way to lose the credibility
you just earned is to bluff a technical answer. The second fastest is
to get defensive about AI assistance — judges in 2026 assume heavy AI
use, so candor reads better than a flinch.

Six questions come up almost every time. Each gets a short answer you
can say in one breath, a follow-up tree for where it goes next, and a
file you can point at if they want proof.

## The question map

The six probes and how they branch. Answer the headline first, then
follow the branch they actually take.

```
  Q&A — the six probes (answer headline, then branch)

  "Is it actually working?" ──┬─ "show me again" → re-run #rag-query
                              └─ "is the answer hardcoded?" → trace
  "What was the hard part?" ──── tool-less model + retrieval bug
  "What's the stack?" ────────── TS monorepo, npm bundle, local Ollama
  "Built in the window?" ─────── yes; own the AI assistance plainly
  "Is a local model good       ┬─ "accuracy?" → evals + the floor
   enough?" ───────────────────┴─ "why not GPT?" → swappable port
  "What's next / a business?" ── buffr → live pgvector; honest scope
```

## Q1 — "Is this actually working, or is it a mockup?"

```
┃ "Working. The retrieval and the scoring are real code — the
┃  in-browser demo runs a real vector store and the real
┃  precision-at-k scorers; only the embedder is a deterministic
┃  stub so it can't flake on stage. And the CLI runs the same agent
┃  against a real local Gemma model with real Ollama embeddings."
```

  → If they push ("prove the answer isn't hardcoded"): re-run the RAG
    page and open the trace panel — show the `step` → `tool_call_start`
    → `tool_call_end` → `model_usage` events. "That's a real
    `CapabilityEvent` trace from the agent loop, not a string."
  → Anchor: `apps/studio/src/agent-runners.ts` (`runRagQueryFixtureReplay`,
    real `InMemoryVectorStore` + `scorePrecisionAtK`), and the live
    `ask` CLI at `packages/agents/rag-query/scripts/ask.ts`.

## Q2 — "What was the hardest part?"

```
┃ "Teaching a local model to call tools when it has none. Gemma has
┃  no tool-calling API, so the provider renders the tools into the
┃  prompt, demands a JSON tool call, and parses it back — with a
┃  retry when the JSON is malformed. The subtle bug: a weak model
┃  would hallucinate a filter key and the naive filter wiped every
┃  result. I fixed the filter to ignore keys a chunk doesn't have,
┃  added a top-k floor, and wrote a regression test."
```

  → If they go deeper on the loop: hand it to the interview-defense
    book — "happy to walk the whole loop, it's in my notes."
  → Anchor: `packages/providers/gemma/src/gemma-provider.ts`;
    `matchesFilter` + `minTopK` in
    `packages/retrieval/src/search-knowledge-base-tool.ts`; the test in
    `packages/retrieval/test/search-knowledge-base-tool.test.ts`.

## Q3 — "What's the stack?"

```
┃ "TypeScript monorepo, ESM, npm workspaces — sixteen internal
┃  packages bundled into one published package on npm. React plus
┃  Vite for Studio. Models behind one provider contract: Anthropic,
┃  OpenAI, or local Gemma through Ollama. Retrieval behind a vector
┃  store contract: in-memory now, Postgres pgvector in the companion
┃  repo. Tests on Node's built-in runner, Playwright for Studio."
```

  → If "why a monorepo / why bundle 16 packages?": "to ship one clean
    install — `@rlynjb/aptkit-core` inlines them all into a single
    tarball so a host app gets one dependency, not sixteen."
  → Anchor: `.aipe/project/context.md` stack section; `packages/core`.

## Q4 — "Did you build this during the hackathon window?"

Own the AI assistance directly. No defensiveness.

```
┃ "Yes. And I'll be straight about it — I used AI heavily, the way
┃  everyone does now. The model wrote a lot of the boilerplate. What
┃  I did was the architecture: deciding the two contracts the whole
┃  thing hangs off, catching the retrieval bug when the demo came
┃  back empty, and designing the eval seam so I'd know when a change
┃  broke something. The judgment calls are mine; the typing was
┃  shared."
```

  → If they probe what *you* specifically decided: the port boundaries
    (model provider + vector store), the emulated-tool-calling
    approach, and the eval-gated capability shape that every agent
    follows.
  → This answer wins by being matter-of-fact. A defensive answer here
    reads worse than the honest one.

## Q5 — "Is a local model actually good enough for this?"

```
┃ "For grounded retrieval over a small corpus, yes — and that's
┃  exactly why the evals matter. The local model is weaker, so it
┃  under-fetches and sometimes hallucinates arguments. Instead of
┃  hoping it behaves, I floor the top-k and score every retrieval
┃  with precision and recall, so I can see when it's wrong. And if a
┃  task needs a stronger model, I swap the provider adapter — the
┃  loop doesn't change."
```

  → If "why not just use GPT-4 / Claude?": "I can — same contract.
    The point of building on the provider port is that local vs cloud
    is a one-line swap, not a rewrite. Local is the default because it
    runs with no key and no network."
  → Anchor: `minTopK` floor and the `precision-at-k` scorers;
    `ModelProvider` contract in `@aptkit/runtime`.

## Q6 — "What's next — is there a business here?"

Honest scope. Don't oversell.

```
┃ "The immediate next step is real: a companion repo graduates this
┃  same toolkit to a live Supabase pgvector store — same vector
┃  contract, real persistence. As for a business — right now it's a
┃  toolkit, not a product. The honest version is it's reusable
┃  infrastructure for building grounded agents, and the next thing I
┃  want to learn is whether teams actually reach for it. That's why
┃  the ask is 'try it and tell me where it breaks.'"
```

  → If they push on scale ("does this handle production load?"):
    "Not yet — there's no horizontal scaling, no queue infrastructure,
    no multi-region. That's deliberately out of scope for a toolkit;
    the durable store lives in the companion repo and that's where
    the operational work goes." Naming the gap honestly beats
    pretending it's there.
  → Anchor: buffr companion repo + the `VectorStore` contract that
    `PgVectorStore` implements.

## The two rules for all of it

```
  Q&A POSTURE

  ┌─ if you KNOW it ──────────────┐   ┌─ if you DON'T ────────────────┐
  │ answer in one breath, name    │   │ "I don't know off the top of   │
  │ the file, offer to show it    │   │  my head — here's how I'd find │
  │                               │   │  out," then name the file/path │
  └───────────────────────────────┘   └────────────────────────────────┘

  never bluff a technical answer; never get defensive about AI use
```

You don't have to win every follow-up. You have to be honest on every
one. The judge remembers the demo and the candor, not whether you knew
every line number.
