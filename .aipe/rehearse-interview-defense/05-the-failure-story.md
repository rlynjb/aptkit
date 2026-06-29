# Chapter 5 — The Failure Story

"What happens when things go wrong?" This question tests operational thinking
— whether you designed for the unhappy path or only the demo. AI systems have
a particularly nasty failure surface because the model itself is a source of
garbage: it returns malformed JSON, hallucinates tool arguments, refuses, or
times out. A candidate who only thought about the happy path falls apart
here. You didn't, so this chapter is about walking the failure surfaces in
aptkit and naming what the system actually does at each one.

There's one failure in here that's special — the silent-empty-results problem
— and I want you to lead with it, because it's the one that's honest about a
gap *and* shows you found it. We'll set it up here and the full war story is
in Chapter 6.

## The chapter-opening diagram — the failure-mode map

Every box is a failure surface; under each is what the system does. The honest
one — the unbuilt warning — is marked. Don't hide it; lead with it.

```
THE FAILURE SURFACES — what goes wrong, what the system does

  ┌─ MODEL RETURNS MALFORMED JSON ──────────────────────────┐
  │  response: parseAgentJson tolerates messy output;       │
  │  gemma provider retries the parse; structured           │
  │  generation retries on validation failure.              │
  └──────────────────────────────────────────────────────────┘
  ┌─ MODEL HALLUCINATES A TOOL FILTER ──────────────────────┐
  │  response: matchesFilter IGNORES keys absent from a     │
  │  chunk's meta — a bogus {textContains} can't zero the   │
  │  results. (this is THE war-story fix — Ch06.)           │
  └──────────────────────────────────────────────────────────┘
  ┌─ MODEL LOOPS FOREVER (never answers) ───────────────────┐
  │  response: maxTurns ceiling + forceFinal drops tools    │
  │  and forces a synthesis answer on the last turn.        │
  └──────────────────────────────────────────────────────────┘
  ┌─ LOCAL PROVIDER DOWN / CLOUD API OUTAGE ────────────────┐
  │  response: sequential fallback chain tries the next     │
  │  provider; local context-window guard rejects too-big   │
  │  prompts before the call.                               │
  └──────────────────────────────────────────────────────────┘
  ┌─ DIMENSION MISMATCH (wrong embedder vs corpus) ─────────┐
  │  response: VectorStore carries its own dimension and    │
  │  THROWS LOUDLY at wiring time. fail fast, not silent.   │
  └──────────────────────────────────────────────────────────┘
  ┌─ ★ SEARCH RETURNS ZERO HITS ON A GOOD CORPUS ★ ─────────┐
  │  response: ⚠ NOT YET BUILT — empty results are SILENT.  │
  │  the model just says "not available." the teachable gap.│
  └──────────────────────────────────────────────────────────┘
```

Five of six surfaces have a real, named response. The sixth — silent empty
results — is the honest gap, and naming it yourself is stronger than getting
caught on it. Let's walk the live ones, then the gap.

### Question 1 — "What happens when the model returns garbage?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "The LLM returns malformed JSON or a tool call    │
│    you didn't expect. What does your system do?"    │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Did you treat the model as a trusted oracle or as │
│   an untrusted input source? AI systems fail here   │
│   constantly — did you build for it?                │
└─────────────────────────────────────────────────────┘
```

> "I treat the model's output as untrusted input, because with a local Gemma
> it genuinely is. Three layers. First, `parseAgentJson` in the runtime is
> tolerant — it extracts JSON out of messy output rather than assuming clean
> output. Second, the Gemma provider has parse-retry: because Gemma's tool-
> calling is emulated as JSON-in-text, `parseToolCall` can fail, and the
> provider retries rather than crashing. Third, structured generation retries
> on a *validation* failure — if the parsed JSON doesn't match the expected
> shape, it asks again.
>
> The principle is that the model is an untrusted boundary, like any user
> input. You never let a malformed response from it crash the loop or
> propagate downstream unvalidated."

The "untrusted input" framing is the senior move — it connects to something
you know cold from seven years of frontend: you never trust what comes over
the wire from a client. The model is just another untrusted source over a
wire. Use that bridge.

```
┃ The model's output is untrusted input. You validate it
┃ like anything else that comes over a wire.
```

### Question 2 — "What happens when the provider is down?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Ollama isn't running, or the Anthropic API is    │
│    down. What does a request do?"                   │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Did you build any degradation path, or does one   │
│   dead dependency take the whole thing down?        │
└─────────────────────────────────────────────────────┘
```

> "There's a sequential fallback provider — it tries providers in order and
> moves to the next on failure, all behind the same `complete()` contract, so
> the loop doesn't know or care which provider answered. And there's a local
> context-window guard provider that rejects a prompt that's too big *before*
> the call, so I fail with a clear error instead of a confusing provider-side
> truncation.
>
> What I'll be honest about: the fallback is a chain, not a circuit breaker. I
> don't have retry-with-backoff or health-checking — if a provider is
> flapping, I'd retry it every request until the chain moves on. For a
> portfolio system that's acceptable; for production I'd add backoff and a
> breaker. I know which one I have."

That honesty — "it's a chain, not a circuit breaker, and here's the
difference" — is exactly the operational precision interviewers are listening
for. You're naming the limit of what you built without apologizing for it.

### Question 3 — the silent failure (set up here, paid off in Ch06)

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "What happens when retrieval returns nothing on a │
│    corpus that definitely has the answer?"          │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you know your system's SILENT failures — the   │
│   ones that don't throw, don't log, just quietly    │
│   produce a wrong answer? Those are the dangerous    │
│   ones.                                              │
└─────────────────────────────────────────────────────┘
```

This is the one to lead with, because it's the most honest and the most
impressive — you found a silent failure, fixed the *cause*, and you know the
*warning* is still missing.

> "This is the one that bit me. The agent said 'not available' on a corpus
> that absolutely had the answer. The root cause was a hallucinated filter —
> I'll tell that whole story in a second — and I fixed `matchesFilter` so a
> bogus filter key can't zero out the results. But here's the honest part:
> the *deeper* problem is that empty retrieval results are still **silent**.
> When `search_knowledge_base` returns zero hits, nothing warns. The model
> just synthesizes 'I don't have that' and moves on. I fixed the specific
> cause, but the *class* of bug — silent empties — is still open. The fix I'd
> build is a zero-hit warning emitted into the `CapabilityEvent` trace so an
> empty result is loud, not silent."

Leading with a bug you found, fixed at the cause, *and* still see the gap in —
that's a top-decile operational answer. It proves you reason about failure
classes, not just instances.

```
"What about silent failures?"
      │
      ├─► IF THEY ASK "what was the actual bug?"
      │     Gemma passed a hallucinated {textContains} filter,
      │     exact-match zeroed every result. → full story Ch06.
      │
      ├─► IF THEY ASK "how'd you fix it?"
      │     matchesFilter now ignores keys absent from a
      │     chunk's meta + a regression test. → Ch06.
      │
      └─► IF THEY ASK "is it fully solved?"
            No — the CAUSE is fixed, the CLASS isn't. Empty
            results are still silent; the zero-hit trace
            warning is unbuilt. I name that honestly.
```

```
╔════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                     ║
║                                                         ║
║   They push into production failure handling you        ║
║   haven't built: "How do you handle a partial write —   ║
║   the embedding succeeds but the upsert fails halfway   ║
║   through a batch? How do you guarantee consistency?"   ║
║                                                         ║
║   aptkit's in-memory store has no transaction story.    ║
║   buffr's PgVectorStore has upsert begin/commit/         ║
║   rollback — but you should be careful claiming          ║
║   guarantees you didn't stress-test under failure.       ║
║                                                         ║
║   Say:                                                  ║
║   "In aptkit's in-memory store there's no partial-write ║
║    story — it's a single-process array, so a batch       ║
║    either completes or the process is gone. buffr's      ║
║    PgVectorStore wraps upserts in a Postgres             ║
║    transaction — begin/commit/rollback — so a failed     ║
║    batch rolls back. What I have NOT done is chaos-test  ║
║    that under real partial failure, so I can tell you    ║
║    the mechanism is there but I haven't proven it under  ║
║    injected faults. That's the kind of thing I'd want a  ║
║    failure-injection test for before I trusted it in     ║
║    production."                                          ║
║                                                         ║
║   What this signals: you know the difference between     ║
║   "the mechanism exists" and "I've proven it under       ║
║   failure," and you don't claim the second from the      ║
║   first. That distinction is pure senior signal.         ║
║                                                         ║
║   Do NOT say:                                            ║
║   "It's transactional so it's safe" — claiming a         ║
║   guarantee you haven't tested under failure is how you  ║
║   lose credibility on everything else you said.          ║
╚════════════════════════════════════════════════════════╝
```

```
        ▸ The dangerous failures are the silent ones. Knowing
          where YOUR system fails quietly is the answer.
```

## What you'd change

The one failure-handling change I'd make first is the zero-hit warning — turn
the silent empty-result case into a loud `CapabilityEvent` warning so it
shows up in the trace and in Studio's replay. The `matchesFilter` fix stopped
the specific cause, but the *system* still can't tell the difference between
"the corpus genuinely doesn't have this" and "retrieval silently returned
nothing." Both produce the same "not available" answer, and only one of them
is correct. Making empty results observable is the highest-leverage
operational fix on the board, and I know exactly where it goes.

## One-page summary — Chapter 5

```
CORE CLAIM
  AI systems fail at the model boundary (garbage output) and
  silently (empty retrieval). Know what YOUR system does at each.

QUESTIONS COVERED
  Q: Model returns garbage? A: untrusted input — parseAgentJson
     tolerance + gemma parse-retry + structured-gen validation retry.
  Q: Provider down? A: sequential fallback chain + context-window
     guard. Honest: it's a chain, NOT a circuit breaker (no backoff).
  Q: Silent empty results? A: matchesFilter fix stopped the cause;
     the CLASS (silent empties) is still open — zero-hit warning unbuilt.
  Q: Partial write / consistency? A: in-mem none; buffr txn
     begin/commit/rollback, but not chaos-tested. (recovery box)

PULL QUOTES
  ▸ The model's output is untrusted input.
  ▸ The dangerous failures are the silent ones.

WHAT YOU'D CHANGE
  Build the zero-hit warning into the CapabilityEvent trace so an
  empty retrieval is loud, not silent — highest-leverage op fix.
```
