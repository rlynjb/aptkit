# Chapter 5 — The failure story

## Opening hook

Here's the thing about the failure story: most candidates have only practiced the happy path. They can walk you through "user asks a question, the model searches, the answer comes back grounded and cited." Then the interviewer asks "okay — what happens when Ollama isn't running?" and the fluency evaporates. They say "I'd add error handling" and you can watch the senior interviewer's pen go down.

This chapter is about the other path. You built a local-first RAG agent — Gemma over Ollama on `localhost:11434`, a from-scratch retrieval pipeline, and a Postgres/pgvector store in buffr that consumes the same contracts. Every one of those seams is a place something can go wrong: the daemon's down, the model emits garbage JSON, the embedder and store disagree on dimension, a multi-chunk write dies halfway. For each surface I want you to be able to say three things in order — **what happens, what's defended, and what's still a gap.** That third one is the senior signal. You already volunteered the gap before they had to dig for it, and that's the move that wins this chapter. There's even a real war story in here: an incident you diagnosed by reading the persisted trajectory backward. That story is worth more than any rehearsed line.

## The chapter-opening diagram — the failure-mode map

This is the map of every failure surface in the system, what the system does at each, and where the honest gap sits. Study this one diagram and you have the spine of the chapter.

```
  THE FAILURE-MODE MAP — five surfaces, three columns each

  ┌─ Provider layer (Gemma / Ollama :11434) ───────────────────────────────┐
  │                                                                         │
  │  (a) OLLAMA UNREACHABLE          (b) MALFORMED MODEL OUTPUT             │
  │   fetch → connection refused      Gemma emits bad JSON for a tool call │
  │   ──────────────────────────      ─────────────────────────────────── │
  │   DEFENDED: fallback chain        DEFENDED: parse-retry (RETRY_NUDGE), │
  │     designed — cloud behind        bounded by maxToolCallAttempts; then│
  │     local in provider-fallback     treat reply as plain text, no crash │
  │   GAP: buffr CLI doesn't wire it  GAP: none load-bearing — degrades    │
  │     yet (next-moves B1); and NO    cleanly to a text answer            │
  │     per-call timeout on the fetch                                      │
  └────────────────────────────────────────────────────────────┬──────────┘
                                                                │ embed()
  ┌─ Retrieval layer (pipeline + store) ──────────────────────▼───────────┐
  │                                                                         │
  │  (c) DIMENSION MISMATCH           (d) RETRIEVAL MISS (the war story)    │
  │   embedder 768 ≠ store dim         good corpus, agent says "not avail" │
  │   ──────────────────────────      ─────────────────────────────────── │
  │   DEFENDED: assertWiring +        DEFENDED (now): matchesFilter ignores│
  │     per-vector assertDimension     filter keys absent from chunk meta  │
  │     → throws LOUDLY at wiring      + regression test                   │
  │   GAP: none — fail-fast on a      GAP: silent empty results — a        │
  │     one-way door is correct        zero-hit retrieval logs NOTHING     │
  │                                    (unbuilt fix: a zero-hit warning)   │
  │                                                                         │
  │  (e) PARTIAL WRITES                                                     │
  │   multi-chunk upsert dies halfway                                      │
  │   ───────────────────────────────────────                             │
  │   InMemoryVectorStore: non-atomic (Map.set per chunk)                 │
  │   buffr PgVectorStore: begin / commit / rollback transaction          │
  └─────────────────────────────────────────────────────────────────────┘
```

That map is the whole chapter. Five surfaces, and for four of the five you can name a real defense in the code and a real gap you haven't closed. Let's walk them.

```
  ┃ "What happens, what's defended, what's still a
  ┃  gap" — say all three, in that order, every time.
```

---

## Surface (a) — Ollama / the model is unreachable

This is the most likely thing to break in day-to-day use, so lead with it. The Gemma provider talks to Ollama over plain HTTP at `localhost:11434`. If the daemon isn't running, the `fetch` throws a connection error and the call fails.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "What happens when Ollama isn't running?"         │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Did you think about the local model as a single   │
│   point of failure? Do you have a designed          │
│   degradation, or did you just assume the daemon    │
│   is always up? Can you separate what you built     │
│   from what you designed-but-haven't-wired?         │
└─────────────────────────────────────────────────────┘
```

**The strong answer, in your voice:**

"Right now the buffr CLI has a hard dependency on local Ollama. If the daemon's down, the `fetch` in the Gemma provider's transport throws and the call fails — I'm honest about that. But the degradation path is already designed and the pieces exist. I have `@aptkit/provider-fallback` — a `FallbackModelProvider` that takes an ordered list of providers, tries each in turn, and records every failed attempt. The intended wiring is Gemma first, a cloud model like Claude or GPT behind it. When Gemma fails, the fallback catches the error, emits a `warning` trace event saying it's trying the next provider, and moves on. If every provider fails, it throws a `ProviderFallbackError` that carries the full list of attempts so you can see exactly what went wrong.

The honest part: in the buffr CLI today, `ask-cmd.ts` wires `ContextWindowGuardedProvider(GemmaModelProvider)` directly — no fallback. That's item B1 in my next-moves doc; it's cheap and it's first on the list because it removes the most likely day-to-day breakage. The pieces are all in aptkit; buffr just hasn't filled that slot yet.

There's a second gap I'd actually fix before the fallback: there's no per-call timeout on the Ollama fetch. The transport passes through an abort signal if the caller provides one, but it doesn't set its own timeout. A wedged daemon — accepting the connection but never responding — would hang the call indefinitely. The fallback chain doesn't help there, because the first provider never *fails*, it just never returns. So the real fix is two moves: a timeout on the fetch so a hung daemon becomes a fast failure, then the fallback chain so that fast failure degrades to cloud."

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I'd add a try/catch    │ "It fails today — the   │
│ and fall back to a      │ CLI hard-depends on     │
│ cloud model if Ollama   │ Ollama. The fallback    │
│ is down. It's pretty    │ provider exists in      │
│ robust."                │ aptkit but buffr hasn't │
│                         │ wired it (next-moves    │
│                         │ B1). And separately:    │
│                         │ there's no per-call     │
│                         │ timeout, so a WEDGED    │
│                         │ daemon hangs — the       │
│                         │ fallback won't even      │
│                         │ catch that. Two fixes,   │
│                         │ in order."              │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Claims a defense that   │ Separates built from    │
│ isn't wired ("it's      │ designed honestly.      │
│ robust"). And it misses │ Names the subtler       │
│ the subtle failure —    │ failure the weak answer │
│ a HUNG daemon, where a  │ misses (hang ≠ crash),  │
│ catch never fires       │ and shows the fix is    │
│ because nothing throws. │ ordered, not one knob.  │
└─────────────────────────┴─────────────────────────┘
```

The distinction between "crashed" and "wedged" is the thing that separates someone who's actually run local models from someone who's read about them. A crash throws; the fallback's `catch` fires. A wedge accepts the socket and goes silent; nothing throws, so nothing catches, and you sit there forever. Name that distinction out loud — it's a production scar, and it reads like one.

```
        ▸ A fallback chain saves you from a model that
          FAILS. It does nothing for a model that HANGS.
          Those need different fixes.
```

Here's where the conversation goes after you give the answer:

```
  "What happens when Ollama isn't running?"
        │
        ▼
  You give the fallback-designed / not-yet-wired answer.
        │
        ├─► IF THEY ASK "why isn't it wired yet?"
        │     Honest: it needs an API key in .env and
        │     it's a deliberate ordering call — local-
        │     first is the whole point, so the local
        │     path got built and hardened first. B1 is
        │     next, not skipped.
        │
        ├─► IF THEY ASK "how does the fallback decide
        │   to fall back?"
        │     shouldFallback predicate, defaults to
        │     "always fall back." Abort errors are
        │     re-thrown, never swallowed — a user
        │     cancel isn't a provider failure.
        │
        └─► IF THEY PUSH ON THE TIMEOUT
              I'd wrap the fetch in an AbortSignal with
              a timeout, so a hung daemon becomes a
              thrown error the fallback can catch. That
              converts a hang into a fail, which is the
              only failure the chain handles.
```

---

## Surface (b) — malformed model output

Gemma has no native tool-calling. The provider emulates it: it renders the tools into the system prompt and demands the model reply with a single JSON object `{"tool": ..., "arguments": ...}`. A 9B local model does not always comply. Sometimes it emits broken JSON, wraps the object in prose, or just answers in plain text.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "What if the model returns malformed JSON         │
│    for a tool call?"                                │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you trust the model's output blindly? When     │
│   you're emulating a capability the model doesn't   │
│   natively have, do you handle the case where it    │
│   gets it wrong — without crashing the whole turn?  │
└─────────────────────────────────────────────────────┘
```

**The strong answer, in your voice:**

"Gemma doesn't have native tool-calling, so I emulate it — I render the tool schemas into the system text and ask for a single JSON object. A local model gets that wrong sometimes, so the provider has a bounded parse-retry. The loop runs up to `maxToolCallAttempts` times, default 2. On each attempt I try to parse a tool call out of the raw text with `parseAgentJson`, which tolerates messy output — code fences, leading prose. If I get a valid call, I return it as a `tool_use` block. If I don't, I check whether the text even *looked* like a botched tool-call attempt — the cheap tell is whether it contains a `{`. If it did, I append a `RETRY_NUDGE` — a corrective message that says 'your last reply wasn't a valid tool call, respond with ONLY this JSON shape' — and try once more.

The part I'm proudest of is the exit. If the retries run out, or if the model just answered in plain prose with no `{` at all, I don't crash and I don't loop forever. I treat the reply as a plain-text answer and return it as a `text` block. That's the right call: for a RAG agent, a model that decided to answer directly instead of searching isn't an error — it's a valid turn. So the worst case isn't a crash; it's a text answer instead of a tool call. The bound matters too — without `maxToolCallAttempts` capping it, a model that's structurally incapable of emitting clean JSON would nudge-retry forever and burn the context window."

```
        ▸ The load-bearing part isn't the retry — it's
          the EXIT. Bad JSON degrades to a plain-text
          answer, never a crash and never an infinite loop.
```

That "treat it as text" fallback is the one people forget. The retry is the obvious part; anyone would add a retry. The signal is naming the bounded exit and *why* a plain-text answer is a legitimate outcome here rather than a swallowed error.

```
  "What if the tool-call JSON is malformed?"
        │
        ▼
  You explain the parse-retry + RETRY_NUDGE + text fallback.
        │
        ├─► IF THEY ASK "why only 2 attempts?"
        │     A weak local model that can't emit clean
        │     JSON won't get there in 5 tries either —
        │     each retry costs a full round-trip and
        │     context. 2 is enough to recover a one-off
        │     fumble without burning budget on a model
        │     that structurally can't comply.
        │
        ├─► IF THEY ASK "how do you tell a real answer
        │   from a failed tool call?"
        │     looksLikeToolAttempt — does the text
        │     contain a '{'. Plain prose has none, so I
        │     don't waste a retry nudging a model that
        │     already gave me a real answer.
        │
        └─► IF THEY ASK "what if it loops forever?"
              It can't — maxToolCallAttempts is the hard
              iteration budget. That's the bound. Without
              it the nudge-retry is unbounded.
```

---

## Surface (c) — dimension mismatch

This one is different from the others, and the difference is the point. An embedder produces 768-dim vectors (nomic). A store is created expecting some dimension. If those disagree, every cosine score is garbage and your rankings are silently wrong. This is a one-way door: a corpus embedded at 768 can only ever be searched by a 768-dim query.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "What if your embedder and vector store           │
│    disagree on dimension?"                          │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you know which errors should be loud and       │
│   which should be recoverable? A mismatch that      │
│   silently corrupts rankings is far worse than a    │
│   crash — do you fail fast on the irreversible      │
│   ones?                                             │
└─────────────────────────────────────────────────────┘
```

**The strong answer, in your voice:**

"This is the one place I deliberately fail loud instead of degrading. Embedding dimension is a one-way door — a corpus embedded at nomic's 768 can never be searched by a different-dimension query, because cosine similarity between mismatched-length vectors is meaningless. So I guard it at two levels. At wiring time, `assertWiring` in the pipeline checks `embedder.dimension === store.dimension` and throws with a message that says exactly which is which and to re-index. That runs in `createRetrievalPipeline`, on every `indexDocument`, and on every `queryKnowledgeBase` — so you can't even construct a misconfigured pipeline. And at the store level, `InMemoryVectorStore.assertDimension` checks every individual vector on upsert and every query vector on search, so even a hand-built chunk with the wrong length throws.

The reasoning: a dimension mismatch isn't a runtime input I should tolerate — it's a configuration bug. If I silently let it through, I'd index unsearchable vectors and return confidently-ranked garbage, and nobody would notice until the answers were quietly wrong. A crash at wiring time is a far better failure than corrupt rankings in production. This is the opposite call from surface (a), where I degrade — and that contrast is intentional. You degrade on transient, recoverable failures. You fail fast on irreversible, silent-corruption failures. Tolerating bad output is only correct when the bad output is *recoverable*."

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I validate the         │ "I fail loud, on        │
│ dimensions to make      │ purpose — it's a        │
│ sure they match and     │ one-way door. Guarded   │
│ throw an error if they  │ at two levels:          │
│ don't."                 │ assertWiring at the     │
│                         │ pipeline seam, and      │
│                         │ assertDimension per      │
│                         │ vector in the store. A  │
│                         │ silent mismatch would   │
│                         │ corrupt every ranking   │
│                         │ invisibly — a crash is  │
│                         │ the better failure."    │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Right behavior, no      │ Names WHY loud is the   │
│ reasoning. Doesn't      │ right call (silent      │
│ distinguish this from   │ corruption > crash),    │
│ failures you'd want to  │ contrasts it with the   │
│ recover from. Sounds    │ degrade-don't-crash     │
│ like a reflex, not a    │ call elsewhere. Shows   │
│ decision.               │ a consistent principle. │
└─────────────────────────┴─────────────────────────┘
```

The whole answer hinges on one sentence: *you degrade on recoverable failures and fail fast on irreversible ones.* That sentence is what makes you sound like you have a failure philosophy rather than a pile of try/catches.

```
        ▸ Loud-vs-quiet is a decision, not a default.
          Degrade the recoverable. Crash on the
          one-way door before it corrupts you silently.
```

---

## Surface (d) — the retrieval-miss incident (the war story)

This is the most valuable thing in the chapter, so slow down here. A real incident, a real diagnosis, a real fix with a regression test. When an interviewer asks "tell me about a bug you debugged," *this* is the answer — not a hypothetical.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Tell me about a time your system gave a wrong     │
│    answer and how you found the cause."             │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Can you debug a system where nothing crashed —     │
│   where the failure is a wrong-but-confident         │
│   answer? Do you have observability that lets you    │
│   reconstruct what happened? And do you fix the      │
│   class of bug, not just the instance?              │
└─────────────────────────────────────────────────────┘
```

**The strong answer, in your voice:**

"The agent told a user something 'wasn't available' even though the corpus clearly contained it. Nothing crashed — that's what made it interesting. The retrieval just came back empty and the model honestly reported it had nothing. No error, no exception, a confidently wrong answer.

I diagnosed it by reading the persisted trajectory backward. In buffr, the `SupabaseTraceSink` persists *every* `CapabilityEvent` into `agents.messages` — not just the assistant's text, but every `tool_call_start`, `tool_call_end`, every model turn, with monotonic timestamps so replay order matches emit order. So I had a complete record of what the agent actually did. Reading the tool calls in reverse, I found it: Gemma had passed a hallucinated filter argument to `search_knowledge_base` — something like `{textContains: "coffee"}`. No chunk's metadata has a `textContains` key. The old exact-match filter required *every* filter key to match, so a key that no chunk carried excluded *every* result. The model invented a filter and silently wiped its own retrieval.

The fix was in `matchesFilter` in the search tool. I changed the predicate so a filter key only excludes a hit that *has* that key with a different value — keys absent from the chunk's metadata are ignored. So a hallucinated key the corpus doesn't know about can't zero out results anymore. And I wrote a regression test that pins it: it seeds a pipeline, fires a query with `filter: {textContains: 'moon'}`, and asserts the results are non-empty — 'a hallucinated filter key should be ignored, not exclude everything.'

Here's the part I'd volunteer before you ask: the real teachable gap isn't the filter, it's that the empty result was *silent*. Empty is a valid return value — sometimes there genuinely are no hits — so nothing logged a warning. I diagnosed this from the trajectory only because every tool call was persisted. The unbuilt fix is a zero-hit warning: when retrieval comes back empty, emit a `warning` event so the next time this happens it's visible at a glance instead of requiring a backward trajectory read. I haven't built that yet. That's the honest gap."

```
        ▸ The bug was a hallucinated filter. The real
          lesson was the SILENCE — empty is valid, so
          nothing logged. Observability found it; a
          zero-hit warning would have surfaced it.
```

Why this story lands: it has the full arc. A symptom (wrong answer, no crash). A diagnostic method that depends on something you actually built (the persisted trajectory). A root cause that's specific (`{textContains}` against exact-match-all). A fix at the right altitude (the predicate, not a band-aid). A regression test that proves it. And then — the move — you volunteer the deeper gap nobody asked about: the silence itself. That last beat is what makes a hiring committee write "thinks about failure classes, not just bug instances."

```
  "How did you find the cause if nothing crashed?"
        │
        ▼
  You explain reading the persisted trajectory backward.
        │
        ├─► IF THEY ASK "why was the filter even there?"
        │     The tool exposes an optional exact-match
        │     filter over chunk metadata. A weak local
        │     model over-eagerly invented one. The fix
        │     makes the tool tolerant of that hallucination
        │     rather than trusting the model to filter well.
        │
        ├─► IF THEY ASK "why not just remove the filter?"
        │     It's useful when the model uses it right
        │     (e.g. {docId: 'cooking'} — there's a test
        │     for that working). The fix keeps the
        │     capability and removes the foot-gun.
        │
        └─► IF THEY ASK "how would you catch this faster
            next time?"
              The zero-hit warning I mentioned. Emit a
              warning event on empty retrieval so it's
              visible in the trace immediately, instead
              of me reading the trajectory backward.
```

---

## Surface (e) — partial writes

Indexing a document chunks it into many pieces and upserts them as a batch. If that batch dies halfway — process killed, connection dropped — you can end up with some chunks written and some not.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "What happens if a multi-chunk write fails         │
│    halfway through?"                                │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you know the difference between atomic and      │
│   non-atomic writes? Do you know which of your       │
│   stores gives you which guarantee, and did you      │
│   choose deliberately?                               │
└─────────────────────────────────────────────────────┘
```

**The strong answer, in your voice:**

"It depends on which store, and I made that distinction on purpose. The `InMemoryVectorStore` upsert loops over the chunks and does a `Map.set` per chunk — it's *not* atomic. If something threw mid-loop, you'd have a partial index. But that store is the zero-cloud build-it-fast adapter — it lives for a single process, and if that process dies the whole Map dies with it, so a partial in-memory index isn't a durability problem. There's nothing to be half-written to.

The durable store is buffr's `PgVectorStore`, and that one wraps the whole batch in a transaction. It connects, runs `begin`, loops the chunks doing an `insert ... on conflict do update`, then `commit`. If anything throws in that loop, the `catch` runs `rollback` and re-throws, and the `finally` releases the connection back to the pool. So the durable path is all-or-nothing: either every chunk in that document lands or none of them do. You never get a half-indexed document in Postgres.

That split is deliberate — the same `VectorStore` contract, two implementations with two different atomicity guarantees, each appropriate to where it runs. The in-memory one trades durability for zero setup; the Postgres one pays for a transaction because it's the store that actually has to survive a crash."

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "Postgres handles that  │ "Depends on the store.  │
│ — it's a database, so   │ In-memory upsert is     │
│ it's transactional."    │ non-atomic (Map.set per │
│                         │ chunk) but it's single- │
│                         │ process so it doesn't   │
│                         │ matter. The durable     │
│                         │ PgVectorStore wraps the │
│                         │ batch in begin/commit/  │
│                         │ rollback — all-or-       │
│                         │ nothing per document.   │
│                         │ Two guarantees, chosen  │
│                         │ per store."             │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "It's a database so     │ Knows that atomicity    │
│ it's transactional" is  │ is something YOU wrap,  │
│ a myth — Postgres only  │ not something Postgres  │
│ gives you atomicity if  │ gives free. Names where │
│ you actually open a     │ the transaction is and  │
│ transaction. The answer │ why the in-memory non-  │
│ assumes the guarantee   │ atomicity is acceptable.│
│ instead of providing it.│                         │
└─────────────────────────┴─────────────────────────┘
```

The trap in this question is the assumption that "it's Postgres" means "it's atomic." It doesn't. Postgres gives you a transaction *if you open one*. The strong answer points at the literal `begin`/`commit`/`rollback` and says "I wrapped it" — because you did, in `PgVectorStore.upsert`.

```
        ▸ Postgres doesn't make your batch atomic. The
          begin/commit/rollback you wrapped around it does.
```

---

## When you don't know

There's one place in this chapter where a senior interviewer can push you straight past your depth, and you should know it's coming. It's the recovery-and-consistency question on the durable store — what happens to in-flight transactions on a crash, isolation levels, concurrent writers to the same chunk. You wrote the `begin`/`commit`/`rollback`; you did not study Postgres's WAL or MVCC internals. Don't fake it.

```
╔═══════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                   ║
║                                                       ║
║   They push past the transaction into recovery        ║
║   internals: "What isolation level is that running    ║
║   at? What happens to an in-flight commit if the      ║
║   process dies between begin and commit? How do two   ║
║   concurrent upserts to the same chunk id resolve?"   ║
║                                                       ║
║   Say:                                                ║
║   "I wrapped the batch in begin/commit/rollback so a  ║
║    failed document write rolls back as a unit, and    ║
║    upsert collisions resolve via ON CONFLICT DO        ║
║    UPDATE on the chunk id. I haven't gone deep into    ║
║    Postgres's isolation levels or WAL recovery —       ║
║    I'm relying on the default isolation and the        ║
║    transaction wrapper. If we expected concurrent      ║
║    writers to the same rows under load, that's where   ║
║    I'd dig in next. Want to walk me through what       ║
║    you'd watch for there?"                            ║
║                                                       ║
║   What this signals: you own exactly what you built   ║
║   (the transaction, the ON CONFLICT clause), you're   ║
║   precise about the edge of your knowledge, and you    ║
║   name the condition (concurrent writers under load)   ║
║   that would force you to learn the rest. Three        ║
║   senior signals.                                     ║
║                                                       ║
║   Do NOT say:                                         ║
║   "Postgres handles all the concurrency stuff          ║
║    automatically, so it's fine."                      ║
║   That's the myth from surface (e), and an             ║
║   interviewer who asked the question already knows     ║
║   it's not automatic. Hand-waving in the exact         ║
║   territory they're probing is the fastest way to      ║
║   turn a small gap into a no-hire.                    ║
╚═══════════════════════════════════════════════════════╝
```

This is squarely in the honest-gap territory from your profile — distributed systems and database internals at scale aren't in your portfolio yet, and the interviewer probing transaction recovery is testing exactly that. The recovery move is to land hard on what you *did* build (the wrapper, the `ON CONFLICT` clause) and be crisp about the edge. A precise "here's where my knowledge ends and here's what would push me to extend it" beats a vague gesture at "Postgres handles it" every time.

---

## What you'd change

If I were hardening this for real failure tolerance today, I'd do three things in order, and the order is the point. First, a **per-call timeout on the Ollama fetch** — it's the cheapest fix and it closes the worst gap, the wedged-daemon hang that no `catch` ever fires on. Second, **wire the fallback chain in the buffr CLI** (next-moves B1), so a failed local call degrades to cloud instead of dying — but that only helps once the timeout converts hangs into failures, which is why it's second. Third, the **zero-hit retrieval warning** — emit a `warning` event when retrieval comes back empty, so the silent-empty-result class that caused the war story becomes visible at a glance instead of requiring a backward trajectory read. None of these is large. What I'd resist changing: the loud dimension-mismatch failure and the bounded parse-retry-then-text exit. Those are already the right calls — failing fast on the one-way door and degrading gracefully on recoverable bad output — and "improving" them would mean making them worse.

---

## One-page summary — the night before

**Core claim:** For every failure surface, say three things in order — what happens, what's defended, what's still a gap. Volunteering the gap is the senior signal.

**The five surfaces, one line each:**

```
  (a) Ollama unreachable  → fetch throws. Fallback chain
      DESIGNED (provider-fallback) but buffr CLI hasn't
      wired it (next-moves B1). And NO per-call timeout —
      a wedged daemon hangs, and the chain can't catch a
      hang. Two fixes: timeout, then fallback.

  (b) Malformed output    → parse-retry with RETRY_NUDGE,
      bounded by maxToolCallAttempts (default 2), then
      degrades to a plain-text answer. Never crashes,
      never loops. The bounded EXIT is the load-bearing part.

  (c) Dimension mismatch  → throws LOUD at wiring time
      (assertWiring) AND per-vector (assertDimension).
      One-way door — degrade is wrong here; silent
      corruption is worse than a crash.

  (d) Retrieval miss (war story) → agent said "not
      available" on a good corpus. Diagnosed by reading
      the persisted trajectory backward (SupabaseTraceSink
      persists every event). Root cause: hallucinated
      {textContains} filter wiped results under exact-match.
      Fixed matchesFilter to ignore absent keys + regression
      test. GAP: empty results are silent — unbuilt fix is
      a zero-hit warning.

  (e) Partial writes      → InMemoryVectorStore upsert is
      non-atomic (single-process, doesn't matter). buffr
      PgVectorStore wraps the batch in begin/commit/rollback
      — all-or-nothing per document. Postgres isn't atomic
      for free; the wrapper makes it so.
```

**The pull quotes:**

```
  ┃ "What happens, what's defended, what's still a
  ┃  gap" — say all three, in that order, every time.

        ▸ A fallback chain saves you from a model that
          FAILS. It does nothing for a model that HANGS.

        ▸ Degrade the recoverable. Crash on the one-way
          door before it corrupts you silently.

        ▸ The bug was a hallucinated filter. The real
          lesson was the SILENCE.
```

**What you'd change:** Per-call timeout on the Ollama fetch (closes the hang gap), then wire the fallback chain in buffr (B1), then a zero-hit retrieval warning (kills the silent-empty class). Don't touch the loud dimension guard or the bounded retry-then-text exit — those are already right.
