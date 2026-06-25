# Design docs — overview

Three decisions in this repo earned a written RFC. The other significant choices did not, and saying which ones got cut — and why — is half the point of this page. A design doc is expensive attention; you spend it where the decision is hard to reverse, where a real alternative was on the table, where the blast radius is cross-cutting, and where a reviewer will stop nodding and ask "why this way?" Everything below is ranked against exactly that bar.

This book is the *written* counterpart to the interview-defense book. Same decisions, same reader, same coach voice — but where the defense book rehearses what you *say* under questioning, these are the artifacts you put in front of a reviewer to get alignment before the questioning starts. Lead with the decision, own the cost, name what's still open.

---

## The bar — warrants a doc vs skip

```
  WHICH DECISIONS GOT A DOC

  warrants a doc                    skip
  ──────────────                    ────
  hard to reverse                   a default nobody questions
  a real alternative existed        one obvious way to do it
  cross-cutting blast radius        local, contained
  reviewer asks "why this way?"     self-explanatory
```

A decision has to clear most of that bar, not one corner of it, to cost a reader a full RFC.

---

## The three that cleared it (ranked)

Ranked by how much a skeptical reviewer would push, and how expensive the wrong call would have been.

```
  RANK   DECISION                         WHY IT CLEARED THE BAR
  ────   ────────                         ──────────────────────
   1     Emulated tool-calling            hard to reverse (it's load-bearing
         (01)                             for the whole agent loop), 3 real
                                          alternatives, a reviewer's first
                                          question is "why not just use Claude?"

   2     RAG from contracts, not          cross-cutting (two consumers ride it),
         a framework (02)                 the obvious move was LangChain, and
                                          "isn't this reinventing the wheel?"
                                          is the guaranteed pushback

   3     Single bundled package           hard to reverse once a consumer pins
         @rlynjb/aptkit-core (03)         it, a real alternative (N packages),
                                          and a non-obvious gotcha already drew
                                          blood — someone WILL ask why bundle
```

**01 — Emulated tool-calling** ranks first because it's the decision the rest of the system leans on and the one a reviewer hits first. The default model is local Gemma2:9b, which has no native tool-calling, yet every consumer expects the native `ModelToolUseBlock` shape. `GemmaModelProvider` fakes native tools end to end. Three real alternatives existed (cloud frontier model, wait for a local native-tool model, constrained decoding) and each lost for a reason you can state. That's a doc.

**02 — RAG from contracts** ranks second because the blast radius is the widest in the repo: two independent consumers now ride the same two contracts — buffr's `PgVectorStore` and `@aptkit/memory`'s episodic memory — neither of which existed when the contracts were drawn. The obvious alternative (LangChain/LlamaIndex) was a legitimate choice for a one-off app, which is exactly what makes the decision non-obvious enough to write down: you have to name the flip condition, not just dunk on the framework.

**03 — Single bundled package** ranks third but is the most concretely *scarred*. Publishing one `@rlynjb/aptkit-core` tarball with `bundledDependencies` inlining 16 internal packages is a real fork in the road — the alternative (16 separately-versioned packages) is the textbook monorepo answer and the right answer once there's a second consumer. And it already bit: a `.gitignore` interaction shipped a JS-free tarball at 0.4.0. A decision that drew blood and has a named flip condition warrants the writeup.

---

## What got SKIPPED, and why

Cutting these is a signal, not laziness. None of them clears the bar.

```
  SKIPPED DECISION                  WHY IT'S NOT A DOC
  ────────────────                  ──────────────────
  node:test over jest/vitest        a default nobody would fight you on for a
                                    zero-dependency library; the runner is
                                    incidental. The real design (injectable
                                    transports) is already covered inside doc 01.

  InMemoryVectorStore vs            NOT an independent decision — it's a direct
  PgVectorStore split               consequence of doc 02's contracts. Once the
                                    VectorStore contract exists, "in-memory
                                    reference impl here, pgvector in the
                                    deployment repo" is the obvious fill. Writing
                                    it as its own RFC would double-count 02.

  ModelProvider.complete()          a clean seam, but the contract itself is the
  as the provider seam              expected shape, not a contested call. Its
                                    most interesting consequence — emulation
                                    living inside one adapter — is the SUBJECT of
                                    doc 01, where the tension actually lives.

  768-dim nomic-embed-text          an integration pick, not a design decision.
  as the embedder                   No alternative was seriously weighed (no
                                    benchmark run); it's local-first plumbing.
```

The pattern: a decision that's *downstream* of a documented one (the store split, the provider seam) does not get its own doc — it gets a paragraph inside the doc it depends on. Three RFCs, not six, is the discipline the bar is supposed to enforce.

---

## The RFC template (reuse this)

Every doc in this book — and every design doc you write after — fills the same nine-part spine. The shape is the value: a reviewer who knows the spine can find your alternatives section in two seconds and judge whether you did the work.

```
  THE RFC SPINE — one decision, nine parts

  ┌─────────────────────────────────────────────────────────┐
  │ 1. Title + one-line summary   the decision, up top,      │
  │                               no suspense                 │
  │ 2. Context / problem          the real constraint that    │
  │                               forced the call             │
  │ 3. Goals & non-goals          explicit non-goals stop     │
  │                               scope fights                 │
  │ 4. The decision  ★DIAGRAM★    the shape before the prose  │
  │ 5. Alternatives considered    2–3 real options + why each │
  │                               lost ("design it twice")    │
  │ 6. Tradeoffs accepted         "we chose X, accepting Z"   │
  │ 7. Risks & mitigations        what guards the downside    │
  │ 8. Rollout / migration        how it ships safely         │
  │ 9. Open questions             what's still undecided      │
  └─────────────────────────────────────────────────────────┘
```

Two parts carry the most weight under review:

> ┃ Section 5 is the one reviewers read first to decide if you
> ┃ did the work. A doc with no alternatives reads as a default
> ┃ you backed into, not a decision you made.

> ┃ Section 9 is the staff signal. Naming the open question
> ┃ before the reviewer finds it is the difference between
> ┃ "didn't think of it" and "scoped it out on purpose."

---

## How to use these

- **Before a review or a defense:** read the doc for the decision under scrutiny. The "where a reviewer pushes" callouts are the questions you'll actually get; the framing next to them is the sentence that gets the yes.
- **As a promo artifact:** these are the written evidence that the unusual calls in this repo were decisions, not accidents. Each one names a cost paid and a flip condition — that's what reads as staff.
- **On update:** these drift when the *code* changes — a chosen design gets replaced, a new significant decision appears, an open question gets answered. Reconcile against the files, surgically. Don't rewrite a doc because the prose feels stale; rewrite it because the decision moved.
- **The discipline to keep:** when a new decision tempts a fourth doc, run it through the bar above. If it's downstream of an existing doc (like the store split is downstream of 02), it's a paragraph, not a file.
