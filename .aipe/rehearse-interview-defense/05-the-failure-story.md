# Chapter 5 — The Failure Story

"What happens when things go wrong?" tests whether you thought past the happy path. A demo handles the case where the model returns clean JSON, the corpus has the answer, and the database accepts the write. Production is the other cases: the model API is down, the model hallucinates a tool argument, the database is read-only, the write half-commits. This chapter walks the failure surfaces actually in aptkit and names what the system does in each — because for several of them, you built a real answer.

The honest frame: some of these you handled deliberately and can point at the code. One of them — silent empty results — you did NOT handle, and naming that gap is a stronger answer than pretending the system is bulletproof.

## The chapter-opening diagram — the failure-mode map

Each failure surface as a box, with what the system actually does. The unbuilt one is marked.

```
  FAILURE SURFACES — what aptkit does in each

  ┌─ model API down / slow ───────────────────────────────────────┐
  │  → FallbackModelProvider: sequential chain, tries next adapter │
  │    behind the same port when one fails                         │
  └────────────────────────────────────────────────────────────────┘
  ┌─ model returns malformed tool JSON ───────────────────────────┐
  │  → gemma provider: parse, retry ONCE with corrective nudge,    │
  │    then treat prose as a real answer (doesn't loop forever)    │
  └────────────────────────────────────────────────────────────────┘
  ┌─ model hallucinates a filter argument ────────────────────────┐
  │  → matchesFilter is hallucination-tolerant: a filter key only  │
  │    excludes hits that HAVE the key with a DIFFERENT value      │
  └────────────────────────────────────────────────────────────────┘
  ┌─ embedding dimension mismatch ────────────────────────────────┐
  │  → fails LOUD at wiring time: store rejects any vector whose   │
  │    length != its dimension. A one-way door, caught early       │
  └────────────────────────────────────────────────────────────────┘
  ┌─ partial write to the durable store (buffr) ──────────────────┐
  │  → PgVectorStore upsert wraps begin / commit / ROLLBACK        │
  │    so a failed batch doesn't half-commit                       │
  └────────────────────────────────────────────────────────────────┘
  ┌─ loop runs away ──────────────────────────────────────────────┐
  │  → hard maxTurns budget + forced synthesis on the last turn    │
  └────────────────────────────────────────────────────────────────┘
  ┌─ corpus has no answer → ZERO hits ────────── ✗ NOT HANDLED ───┐
  │  → results come back empty SILENTLY. No zero-hit warning.      │
  │    This is the real gap (and the war story of chapter 6).      │
  └────────────────────────────────────────────────────────────────┘
```

The shape to carry: most failure surfaces have a deliberate, point-at-able response — fallback, retry-once, rollback, fail-loud, bounded loop. The one that doesn't is the silent-empty-results case, and you say so before they find it.

## Question 1 — the LLM API goes down

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Your model provider has an outage mid-request. What    │
│    happens?"                                              │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Did you treat the model as a service that fails, or as  │
│   infallible infrastructure? Is there a degradation path  │
│   or does the whole thing throw?                          │
└─────────────────────────────────────────────────────────┘
```

> "The model is behind the `ModelProvider` port, and one of the adapters is a fallback chain — `FallbackModelProvider`. It's a sequential chain: it tries the first provider, and if that one throws, it moves to the next behind the same contract. So a configuration can be 'Gemma local, then a cloud model if local is down,' and the loop never knows the difference — it called `complete()` and got a response. The cost is that fallback is sequential, so a failing primary adds its timeout to the latency before the fallback kicks in. That's the tradeoff: resilience over best-case latency."

## Question 2 — the model hallucinates a tool argument

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Your model invents an argument that isn't valid — a    │
│    filter field that doesn't exist. What does the system  │
│    do?"                                                   │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Do you trust the model's output blindly? Did you defend │
│   the tool boundary against a model that lies confidently?│
│   This is the AI-specific failure mode and it separates   │
│   people who've shipped LLM systems from people who haven't│
└─────────────────────────────────────────────────────────┘
```

This is your signature defense — own it fully.

> "This one I learned the hard way, and the fix is in the code. The `search_knowledge_base` tool accepts an optional metadata filter. A model — especially a smaller local one — will sometimes hallucinate a filter key that isn't real metadata, like `{textContains: "..."}`. The naive implementation does an exact match on every filter key, which means a hallucinated key matches nothing and silently zeroes every result. So `matchesFilter` is hallucination-tolerant by design: a filter key only EXCLUDES a hit if that hit HAS the key with a different value. A key the hit doesn't have can't wipe the result. The comment in `search-knowledge-base-tool.ts` literally says a hallucinated filter can't silently wipe every result. That's a deliberate defense against a model that invents arguments, and I built it because I got bitten by exactly this — which is the bug in the next chapter."

```
  ▸ The model lies confidently. The tool boundary is where
    you stop trusting it — a hallucinated filter key must not
    be able to silently zero your results.
```

## Question 3 — a partial write to the durable store

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "You're upserting a batch of chunks and the write fails │
│    halfway. What state is the store in?"                  │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Transactional thinking. Do you understand atomicity, or │
│   would your batch leave the store half-written?          │
└─────────────────────────────────────────────────────────┘
```

> "In the durable path — buffr's `PgVectorStore` — the upsert wraps the whole batch in a transaction: begin, insert each chunk, commit, and rollback on any error. So a batch that fails halfway rolls back to the pre-batch state; there's no half-written corpus. The in-memory store in aptkit doesn't have transactions — it's an array — but it also doesn't survive a process restart, so there's no durability claim to violate. The transactional guarantee lives where the durability does, in buffr, which is the right place for it."

## When you don't know — the silent empty result

This is the failure surface you did NOT build a guard for. Don't hide it — lead with it.

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW (or rather: WHEN YOU DIDN'T BUILD IT)  ║
║                                                           ║
║   They ask: "What happens when the corpus genuinely has   ║
║   no answer to the query? Zero relevant chunks?"          ║
║                                                           ║
║   You did not build a zero-hit warning. The search        ║
║   returns an empty list, the model synthesizes from        ║
║   nothing, and there's no signal that retrieval came back ║
║   empty. This is a real, known gap — and it's the gap     ║
║   that caused your hardest bug.                            ║
║                                                           ║
║   Say:                                                    ║
║   "That's the honest weak spot. Right now empty results   ║
║    are SILENT — the search returns an empty list, the     ║
║    loop forces synthesis, and the model answers from      ║
║    nothing without any signal that retrieval failed. I    ║
║    know this gap precisely because it caused my hardest    ║
║    bug: an agent said 'not available' on a corpus that    ║
║    had the answer, and the silence is what made it hard   ║
║    to diagnose. The fix I'd build is a zero-hit warning   ║
║    emitted as a CapabilityEvent so an empty retrieval is  ║
║    visible in the trace instead of swallowed. I haven't   ║
║    shipped it yet."                                       ║
║                                                           ║
║   What this signals: you know your own gap by file and    ║
║   by incident, you can name the exact fix, and you volun- ║
║   teer it instead of being caught. A named, understood    ║
║   gap is a senior signal — it's the opposite of a         ║
║   surprise.                                               ║
║                                                           ║
║   Do NOT say:                                             ║
║   "It handles that fine, it just returns no results."     ║
║   "Returns no results" with no warning IS the bug. Don't  ║
║   dress the gap up as a feature.                          ║
╚═══════════════════════════════════════════════════════════╝
```

## The follow-up tree — operational depth

```
  "What happens when the model API is down?"
        │
        ▼
  Fallback chain tries the next provider behind the same port.
        │
        ├─► IF THEY ASK "what if ALL providers are down?"
        │     "Then complete() throws and the loop surfaces an
        │      error CapabilityEvent — the trace records the failure.
        │      There's no offline cache of answers; degradation is
        │      'fail visibly,' not 'serve stale.'"
        │
        ├─► IF THEY ASK "how do you know a failure happened?"
        │     "The loop emits a discriminated CapabilityEvent union —
        │      step, tool_call_start/end, model_usage, warning, error.
        │      buffr persists it to agents.messages; Studio replays it.
        │      Failures are in the trace, not just the logs."
        │
        └─► IF THEY ASK "what about malformed model output mid-loop?"
              "The gemma provider retries bad tool JSON once with a
               corrective nudge, then treats prose as a real answer —
               so a model that can't produce clean JSON degrades to a
               text answer instead of an infinite retry."
```

## What you'd change

You'd close the silent-empty-results gap first — it's the highest-leverage operational fix in the codebase, and you already know the shape: emit a zero-hit `CapabilityEvent` warning when `search_knowledge_base` returns nothing, so an empty retrieval shows up in the trace rather than getting laundered into a confident wrong answer. The reason it isn't built isn't that it's hard — it's that the system fails silently, so nothing ever forced the issue until you hit the bug in chapter 6. That's the lesson: the dangerous failures are the silent ones.

## One-page summary

**Core claim:** Most failure surfaces have a deliberate, point-at-able response — fallback chain, retry-once, hallucination-tolerant filter, fail-loud dimension check, transactional rollback, bounded loop. The one that doesn't (silent empty results) you name before they find it.

**Questions covered:**
- *Model API down* → `FallbackModelProvider` tries the next adapter behind the port; cost is sequential timeout latency.
- *Hallucinated tool argument* → `matchesFilter` only excludes hits that HAVE the key with a different value; a fake key can't zero results.
- *Partial write* → buffr's `PgVectorStore` wraps the batch in begin/commit/rollback; the in-memory store makes no durability claim.
- *Zero relevant chunks* → SILENT today; the real gap; fix is a zero-hit `CapabilityEvent` warning; caused the chapter-6 bug.

**Pull quote:** The model lies confidently. The tool boundary is where you stop trusting it.

**What you'd change:** Build the zero-hit warning. The dangerous failures are the silent ones.
