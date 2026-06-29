# Chapter 06 — The Q&A   (prep only — runs after the clock)

## Opening hook

This chapter never eats your ten minutes. It runs after the buzzer, one-on-one
with whichever judge walked over. The slot is for landing impact; the Q&A is
for holding ground. Different mode entirely — here, depth wins, and the worst
move is bluffing. A judge who builds AI will catch a hand-wave instantly. The
goal for each answer: crisp, honest, one level deeper than the demo went, and
anchored to a file you can name.

Six probes come up at almost every hackathon. Below is the answer for each, the
follow-up tree, and the one rule that governs all of them: when AI assistance
shaped the build, own it flat. Judges in 2026 assume heavy AI use; defensiveness
reads worse than candor.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
  │   PREP ONLY — runs AFTER 10:00, does not count against slot │
  └──────────────────────────────────────────────────────────┘
```

No clock pressure here — but keep each answer tight. A judge asks because they
want a signal, not a lecture.

## The chapter-opening diagram — the six probes and where they go

This is the map of what's coming and how deep each one is allowed to go before
you stop and let them ask the follow-up.

```
  THE SIX PROBES — depth allowed before you stop

  "is it real?" ───────────► npm + the live trace + the regression test
  "what was the hard part?" ► tool-emulation + the hallucinated-filter bug
  "what's the stack?" ──────► TS monorepo, 16 pkgs, Ollama/Gemma, Studio
  "built in the window?" ───► honest: the agents + Studio + RAG capstone
  "is the local model       ► honest: good enough HERE; cloud providers
   good enough?" ──────────►   are drop-ins behind the same contract
  "what's next / business?" ► memory wired in + buffr as the runtime

  rule for all six: answer one level deeper than the demo, name a file,
  then STOP and let them drive the follow-up
```

The discipline the diagram encodes: each answer goes exactly one level past
what the room saw, names a concrete anchor, and stops. You're inviting the
follow-up, not preempting it.

## The body — the six probes

### Probe 1 — "Is this actually working, or is it a mockup?"

```
  ┃ "It's working. The score you saw is computed live by the eval
  ┃  package against the chunks the agent actually retrieved — not
  ┃  a hardcoded label. The browser version replays recorded model
  ┃  responses so it's deterministic, but the retrieval pipeline,
  ┃  the agent loop, and the eval are all real and running in the
  ┃  page. And the same agent runs live against local Gemma — I can
  ┃  show you in the terminal."
```

Anchor: `scorePrecisionAtK` / `scoreRecallAtK` in `@aptkit/evals`, called from
`runRagQueryFixtureReplay` in `apps/studio/src/agent-runners.ts`.

```
  Follow-up tree:
  ├─ "so the answer is recorded?" → "the model's text is recorded, yes —
  │    that's what makes it deterministic. The retrieval and the scoring
  │    run fresh every click. Live Gemma in the CLI isn't recorded."
  └─ "prove the score isn't hardcoded" → change the fixture's relevant set
       or question in rag-query-fixtures.ts; the precision number moves.
```

### Probe 2 — "What was the hard part?"

```
  ┃ "Teaching a model that can't call tools to drive a tool-using
  ┃  agent loop. Gemma has no native tool API, so the provider
  ┃  renders the tool schemas into the prompt and parses a JSON
  ┃  tool call back out, with a retry when it botches the JSON. And
  ┃  that surfaced a real bug — a weak model would hallucinate a
  ┃  metadata filter key that doesn't exist, which silently wiped
  ┃  every retrieval result. The fix makes absent filter keys a
  ┃  no-op, and there's a regression test that locks it."
```

Anchors: `packages/providers/gemma/src/gemma-provider.ts` (the emulation +
parse-retry), `matchesFilter` in
`packages/retrieval/src/search-knowledge-base-tool.ts` (the fix), and the test
*"ignores filter keys absent from chunk metadata (a hallucinated filter does
not wipe results)"* in
`packages/retrieval/test/search-knowledge-base-tool.test.ts`.

```
  Follow-up tree:
  ├─ "why not just use a model with native tools?" → "I wanted it to run
  │    fully local and free — no cloud, no key. The contract means I can
  │    still drop in Anthropic or OpenAI when I want native tools."
  └─ "how did you catch the bug?" → "the eval flagged retrieval returning
       nothing on a question I knew had a relevant doc; the trace showed
       the filter wiping the hits."
```

### Probe 3 — "What's the stack?"

```
  ┃ "TypeScript monorepo, ESM, Node's built-in test runner — no
  ┃  jest. 16 internal packages bundled into one npm release.
  ┃  Models go through a provider contract: Anthropic, OpenAI, and
  ┃  local Gemma over Ollama, with a fallback chain and a context-
  ┃  window guard. Retrieval is a from-scratch pipeline — embedder
  ┃  plus vector store behind swappable contracts, in-memory and
  ┃  Ollama nomic today, pgvector in the companion repo. Studio is
  ┃  React plus Vite."
```

Anchor: the project context — `@rlynjb/aptkit-core`, 16 bundled packages,
`@aptkit/provider-gemma` on Ollama `:11434`.

```
  Follow-up tree:
  ├─ "why Node's test runner over vitest?" → "fewer dependencies; the
  │    eval harness is the real test layer — replay artifact → eval →
  │    promote to fixture → deterministic replay."
  └─ "why a monorepo?" → "to isolate reusable agent parts from app
       product logic — that separation is the whole reason it exists."
```

### Probe 4 — "Did you build this in the hackathon window?"

Own the AI assistance flat — this is where candor wins.

```
  ┃ "The RAG capstone agent, the Studio page that scores it, and
  ┃  the in-browser deterministic demo are the hackathon build, on
  ┃  top of an agent loop and provider layer I'd already extracted
  ┃  from a prior app. I used AI heavily — pair-programming the
  ┃  TypeScript, drafting tests. What I did was the design: the two
  ┃  contracts as the boundary, the tool-emulation approach, and
  ┃  debugging the retrieval-miss when the eval caught it. The
  ┃  architecture decisions are mine; the typing went faster with
  ┃  AI."
```

```
  Follow-up tree:
  ├─ "so AI wrote it?" → "AI wrote a lot of the code; I made the calls
  │    on the boundaries and debugged what the tools got wrong — like
  │    the hallucinated-filter bug, which took understanding the
  │    retrieval path, not just generating code."
  └─ "what's reused vs new?" → "reused: the agent loop, providers,
       extracted from earlier work. New this window: the RAG agent,
       the scored Studio page, the deterministic in-browser demo."
```

### Probe 5 — "Is a local model actually good enough for this?"

```
  ┃ "For this — grounded Q&A over a small personal corpus — Gemma
  ┃  on Ollama is good enough, and the eval is how I know: it
  ┃  scores whether retrieval actually grounded the answer. Where
  ┃  it struggles is tool-calling reliability, which is exactly why
  ┃  the provider has the parse-retry. If I needed stronger
  ┃  reasoning I'd swap in Anthropic or OpenAI — same contract, no
  ┃  agent changes. The point isn't 'local is best,' it's 'the
  ┃  choice is a one-line swap.'"
```

```
  Follow-up tree:
  ├─ "what about bigger corpora?" → "in-memory cosine scan is fine for
  │    a demo corpus; that's what buffr's pgvector is for at scale —
  │    same VectorStore contract."
  └─ "how do you measure 'good enough'?" → "precision@k and recall@k
       on the retrieval, plus the structural and rubric evals on the
       agent output. It's measured, not vibes."
```

### Probe 6 — "Is there a business here / what's next?"

```
  ┃ "Next is wiring the episodic memory engine — it already exists
  ┃  on the same contracts, remember and recall, zero new infra —
  ┃  into an agent that remembers past conversations, and running
  ┃  the whole thing as a persistent local agent through buffr on
  ┃  Supabase. The toolkit itself is open and on npm. Whether
  ┃  there's a business, honestly, I don't know yet — right now
  ┃  it's the substrate I build my own agents on, and I'd rather
  ┃  prove it's useful than pitch a market I can't back up."
```

That last sentence is a strength, not a weakness. Naming the edge of what you
can defend reads as someone who ships, not someone who pitches.

```
  Follow-up tree:
  ├─ "who's the user?" → "developers building agents who don't want to
  │    rebuild the loop, the providers, and the eval harness each time."
  └─ "why open source it?" → "the reusable parts shouldn't be locked in
       an app; that's the whole reason I pulled them out into a package."
```

## The "I don't know" recovery

When a probe goes past what you can defend, say so and convert it into a real
answer — never bluff.

```
  ┃ "I haven't measured that — here's how I'd find out: [the
  ┃  concrete next step]. What I can tell you is [the adjacent thing
  ┃  you do know]."
```

A judge trusts "I don't know, here's how I'd check" far more than a confident
wrong answer. The demo already earned the credibility; don't spend it bluffing.

## The one-page run sheet

```
  ┌─ THE Q&A — prep only, after the clock ───────────────────────────┐
  │ 1 IS IT REAL? score is computed live (scorePrecisionAtK), not     │
  │   hardcoded; retrieval + loop + eval run in-browser; live Gemma   │
  │   in CLI. Anchor: agent-runners.ts.                               │
  │ 2 HARD PART? tool-emulation for tool-less Gemma + hallucinated-   │
  │   filter bug → fix → named regression test.                       │
  │ 3 STACK? TS monorepo, 16 pkgs on npm, provider contract           │
  │   (Anthropic/OpenAI/Gemma), from-scratch RAG, React+Vite Studio.  │
  │ 4 IN THE WINDOW? RAG agent + scored page + in-browser demo are    │
  │   new; loop/providers reused. AI wrote code; design + debug mine. │
  │ 5 LOCAL GOOD ENOUGH? yes here, measured by eval; cloud is a       │
  │   one-line swap behind the contract.                              │
  │ 6 WHAT'S NEXT? memory wired in + buffr on Supabase. Business:     │
  │   "don't know yet" — own it.                                      │
  │                                                                   │
  │ AI USE: own it flat — code assisted, boundaries + debugging mine. │
  │ "I DON'T KNOW": "haven't measured — here's how I'd check; what I  │
  │   can tell you is [adjacent known thing]." Never bluff.           │
  └───────────────────────────────────────────────────────────────────┘
```
