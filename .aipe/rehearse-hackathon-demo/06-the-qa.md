# Chapter 6 — The Q&A   (prep only — runs after the buzzer)

## Opening hook

This chapter never counts against your ten minutes. It runs after the buzzer, in the open conversation, and it's where a good demo either holds or unravels. Judges ask the same handful of questions at every hackathon — "is this actually working?", "what was the hard part?", "what's the stack?", "did you build this in the window?", "is the local model good enough?", "what's next?" — and the presenters who lose are the ones who get defensive or vague. You're not getting defensive. Every one of these has a crisp, honest, speakable answer grounded in code you can open, and most of them you've already half-answered on stage. This chapter is just making sure none of them catch you cold.

One rule runs through all of it: **answer in one or two sentences, then stop and let them follow up.** A Q&A answer that turns into a second talk is how you lose the room you just won. Crisp, true, done.

## The map of likely questions

Here's the decision space. The six standard probes, plus where each one can fork.

```
  Q&A — the six probes and their follow-ups

  "Is it actually working?" ──────► show the trace; it's a real
        │                            loop, not a hardcoded result
        └─► "so the demo's faked?" ─► own the stub embedder + the
                                       recorded responses, explain WHY

  "What was the hard part?" ──────► the silent-zero retrieval bug,
        │                            read the trace backward
        └─► "how did you debug it?" ► the persisted trajectory IS
                                       the debugger

  "What's the stack?" ────────────► TS monorepo, local Gemma via
        │                            Ollama, in-memory store + evals
        └─► "where's the database?" ► buffr: same agents on Supabase
                                       pgvector, one-line swap

  "Did you build this in the      ─► yes, on the real parts; honest
   window?"                          about what AI did vs what I did

  "Local model — good enough?" ───► good enough WITH the guardrails;
                                     honest about where it isn't

  "What's next / a business?" ────► framed as future, not faked;
                                     it's a portfolio + learning build
```

Everything below walks those branches. Read it once; you won't need notes for it.

## The answers

### Q1 — "Is this actually working, or is it a mockup?"

You already answered this in the demo with the trace, so lean on that.

```
  ┃ "It's working — that's why I showed the trace. The model
  ┃  chose to call search, the search ran, and the answer
  ┃  grounded on what came back. It's a real agent loop, not a
  ┃  scripted result. The same agent runs against a live local
  ┃  Gemma through the command line, too."
```

**Follow-up — "but the demo page is in the browser. Isn't that faked?"** This is the sharp version, and you own it head-on:

```
  ┃ "Good catch — and I'll be exact. The in-browser demo swaps
  ┃  two things for determinism: a keyword-hash embedder instead
  ┃  of the real nomic embedder, and recorded Gemma responses
  ┃  instead of a live call. Everything else is the real code —
  ┃  the same RagQueryAgent, the real in-memory vector store,
  ┃  the real eval scorers. I made it deterministic so it can't
  ┃  flake on stage, not to fake the result. The live version
  ┃  runs against real Gemma and real embeddings on the CLI."
```

That's the strongest possible version of this answer: you named exactly what's stubbed (`makeFixtureEmbedder`, the recorded `modelResponses`) and exactly what's real (`RagQueryAgent`, `InMemoryVectorStore`, `scorePrecisionAtK`/`scoreRecallAtK`), and you gave the reason. Precision plus a reason reads as someone who knows their own system; vagueness reads as someone hiding it.

### Q2 — "What was the hard part?"

You seeded this in the build story; here's the full version.

```
  ┃ "Two things. First, teaching a model with no tool-calling to
  ┃  call tools — Gemma, locally. Second, the bug that came out
  ┃  of that: retrieval started silently returning nothing
  ┃  because Gemma hallucinated a filter the store couldn't
  ┃  satisfy. No error, just empty. I found it reading the saved
  ┃  trace backward until the made-up filter appeared, then
  ┃  fixed the matcher to ignore keys a chunk doesn't have and
  ┃  added a regression test."
```

**Follow-up — "how did you actually debug a silent failure?"**

```
  ┃ "The trace. Every turn the agent takes gets recorded — the
  ┃  tool calls, the arguments, the results. So when retrieval
  ┃  came back empty with no error, I read the trajectory
  ┃  backward until I saw the argument that didn't belong: a
  ┃  textContains filter the model invented. The trace is the
  ┃  observability surface — it's the same thing Studio replays."
```

### Q3 — "What's the stack?"

Crisp inventory, no rambling.

```
  ┃ "TypeScript monorepo, published as one npm package with
  ┃  sixteen internal packages bundled inside it. The model is
  ┃  Gemma running locally through Ollama; embeddings are
  ┃  nomic-embed-text, also local. The vector store is in-memory
  ┃  with cosine ranking. Evals are precision and recall at k,
  ┃  plus a rubric judge where Claude grades Gemma's output so
  ┃  the model isn't grading itself. Studio is React and Vite."
```

**Follow-up — "there's no real database. How does this run in production?"** This is your strongest seam; answer it with the one-line swap.

```
  ┃ "aptkit is the library — in-memory on purpose, zero infra.
  ┃  The production version lives in a second repo, buffr, which
  ┃  runs the exact same agents against Supabase Postgres with
  ┃  pgvector. The store implements the same VectorStore
  ┃  contract, so the swap is genuinely one line — new
  ┃  PgVectorStore instead of new InMemoryVectorStore — and the
  ┃  agent is imported unchanged from the published package. I've
  ┃  run it live end to end."
```

If they push into ANN index internals — HNSW graph construction, recall-vs-latency tuning — that's past your hands-on depth, and the honest boundary is stronger than a fake. The interview-defense book's chapter 02 has the full recovery; the short version on stage:

```
╔══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW — vector index internals                 ║
║                                                              ║
║  They ask: "How does your vector search scale? HNSW? How do  ║
║  you tune recall against latency?"                           ║
║                                                              ║
║  Say: "My in-memory store is an exact linear cosine scan —    ║
║  correct, not fast, deliberate for a zero-infra library. The  ║
║  durable store is pgvector, which I'd index with HNSW for     ║
║  scale. I've used HNSW on defaults, not tuned the recall/      ║
║  latency tradeoff myself — if you want to walk through what    ║
║  you'd have me reason about, I'll think it through with you." ║
║                                                              ║
║  This reads as senior: precise on what you built, honest on   ║
║  where your depth ends. Do NOT say "cosine is optimized and   ║
║  pgvector scales automatically" — that's the tell of someone  ║
║  who never looked under the hood.                             ║
╚══════════════════════════════════════════════════════════════╝
```

### Q4 — "Did you build this during the hackathon? How much was AI?"

The 2026 baseline assumes you used AI heavily. Defensiveness reads worse than candor. Own it matter-of-factly — the differentiator is judgment, not typing.

```
  ┃ "Yes, and I used AI heavily — most people did. What I want
  ┃  to be clear about is which parts were judgment. The two
  ┃  contracts, making retrieval a tool the model calls instead
  ┃  of a prompt-splice, bounding the loop — those were my
  ┃  design calls, and I can defend why each one. The AI wrote a
  ┃  lot of the implementation, and I evaluated and corrected it
  ┃  — the hallucinated-filter bug is exactly the kind of thing
  ┃  you only catch by actually reading the trace, not by
  ┃  accepting the diff. The tools sped up the typing; the
  ┃  architecture and the debugging were mine."
```

The move: separate the decisions you made deliberately (the contracts, retrieval-as-tool, the loop budgets) from the code the AI generated that you judged and corrected (caught by reading traces). That's the line judges are actually probing for — can you tell which is which.

### Q5 — "A local 9B model — is it actually good enough?"

Honest answer: good enough *with the guardrails*, and you name where it isn't.

```
  ┃ "For grounded retrieval-QA with the guardrails around it,
  ┃  yes. On its own Gemma will hallucinate a filter or pass a
  ┃  bad top_k — I saw both. So the tool clamps top_k up to a
  ┃  minimum floor, bad tool-call JSON gets one retry then falls
  ┃  back to text, and the eval scores every retrieval so a bad
  ┃  one is visible instead of silent. Where it's weaker is
  ┃  long-horizon reasoning — for that the same contract lets me
  ┃  swap in Claude or GPT without touching the agent. That's
  ┃  the whole point of the model seam."
```

Notice you turned the weakness into the architecture pitch: the local model has limits, *and the contract is exactly what lets you route around them.*

### Q6 — "Is there a business here? What's next?"

Don't oversell. It's a portfolio and learning build; say so, and frame next steps as future.

```
  ┃ "I'll be straight — this is a portfolio and learning build,
  ┃  not a startup. It's my second RAG system, and the point was
  ┃  to build the substrate myself instead of wiring a framework
  ┃  to a cloud API like I did the first time. Where it goes next
  ┃  is technical, not commercial: persistent memory across more
  ┃  agents, a live provider-fallback chain in the production
  ┃  repo, and a hosted deploy. If there's a product in it, it's
  ┃  the 'see whether your agent's answer was actually grounded'
  ┃  piece — but I'm not claiming that today."
```

Honesty here is a strength. A judge trusts "this is a learning build and here's what I learned" far more than a forced business case that collapses on the second question.

## The closing posture

Three things to carry into every Q&A answer, no matter which question comes:

```
  ┌─ ANSWER SHORT ──────────────────────────────────────────┐
  │  one or two sentences, then stop. Let them follow up.    │
  │  A second talk loses the room you just won.              │
  └──────────────────────────────────────────────────────────┘
  ┌─ OWN THE EDGES ─────────────────────────────────────────┐
  │  stub embedder, hallucinating model, no real DB in the   │
  │  library, AI-assisted build — name them before they're    │
  │  pulled out of you. Candor reads as confidence.           │
  └──────────────────────────────────────────────────────────┘
  ┌─ POINT AT CODE ─────────────────────────────────────────┐
  │  every claim maps to a file you can open. "I can show     │
  │  you" beats "trust me" every time.                        │
  └──────────────────────────────────────────────────────────┘
```

When a question goes deeper than this chapter — the emulated-tool-calling parse internals, the pgvector index internals, the eval design — that's the interview-defense book's territory. Its chapter 02 (the architecture and the one-line swap), chapter 05 (the failure story), and chapter 08 (the AI-honesty answer) are the deep versions of Q1, Q2, and Q4 here. Keep them within reach; this chapter gets you through the room, that book gets you through the follow-up conversation.
