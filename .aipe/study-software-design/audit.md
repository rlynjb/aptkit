# Software Design Audit — AptKit

> Pass 1 of the two-pass audit. Eight lenses from *A Philosophy of
> Software Design* (Ousterhout) walked against the live repo, each
> grounded in `path:line`. The deep walks for the recurring design
> moves live in the Pass 2 pattern files (`01-` … `06-`) — this file
> cross-links to them rather than restating them.
>
> Vocabulary note: this guide is the canonical home of the
> **PATTERN VOCABULARY** (port / adapter / client / seam / factory /
> dependency injection / dependency inversion). It's defined once in
> `00-overview.md` and used throughout. Standard term leads, repo's
> local name in parens on first use.

The through-line, stated once: **complexity is the enemy; deep
modules are the weapon.** A module is deep when it hides a lot of
behavior behind a small interface. AptKit's spine — the provider
contract (`ModelProvider`) and the retrieval contracts
(`EmbeddingProvider` / `VectorStore`) — is a set of deliberately deep
modules, and the best findings here are about how much they hide. The
weaknesses are mostly leakage: a few decisions that live in more than
one file and now have to change together.

---

## 1. complexity-in-this-codebase

The diagnostic overview. Where would a change amplify across files,
where does cognitive load spike, where do the unknown-unknowns hide?

For a monorepo of 16 packages this codebase is unusually low-complexity,
and that's not an accident — almost everything routes through three
contracts, so most modules only know the contract, not each other. The
hotspots are the few places where a single fact is written down more
than once.

```
  Complexity hotspots — ranked by change-amplification

  ┌──────────────────────────────────────────────────────────┐
  │ 1. embedding DIMENSION                                     │
  │    one fact, checked in THREE files                        │
  │      pipeline.ts:23 · in-memory-vector-store.ts:37         │
  │      conversation-memory.ts:62                             │
  │    change the rule → edit three places                     │
  ├──────────────────────────────────────────────────────────┤
  │ 2. FixtureModelProvider                                    │
  │    one class, COPIED byte-for-byte into 5 agent packages   │
  │      packages/agents/*/src/fixture-provider.ts (18 lines)  │
  │    fix a replay bug → edit five places                     │
  ├──────────────────────────────────────────────────────────┤
  │ 3. metadata filtering                                      │
  │    lives in the TOOL, not the VectorStore port             │
  │      search-knowledge-base-tool.ts:88 (over-fetch ×4)      │
  │      conversation-memory.ts:94      (over-fetch ×4, min 20)│
  │    same workaround, two magic numbers, two files           │
  └──────────────────────────────────────────────────────────┘
```

These three are the spine of the rest of the audit. None is a crisis —
this is a young, deliberately-factored codebase — but they're the
places where the "one fact, one home" rule is currently broken.
Findings 1 and 3 are different symptoms of the same root cause: the
`VectorStore` port (`packages/retrieval/src/contracts.ts:33`) has no
metadata predicate and doesn't own dimension reconciliation, so callers
re-implement both. See `04-guard-rails-as-information-hiding.md` for the
dimension walk and `03-contract-as-the-product.md` for the missing
predicate.

---

## 2. deep-vs-shallow-modules

Depth = functionality ÷ interface size. Name the deepest (best) and the
shallowest (worst).

**Deepest module — `GemmaModelProvider`**
(`packages/providers/gemma/src/gemma-provider.ts`). Its public surface
is the three-field port (`ModelProvider`): `id`, `defaultModel`,
`complete(request)`. Behind that one method it hides: rendering tools
into system text because Gemma has no native `tools` array
(`buildSystemText`, :133), parsing messy model output back into a
structured tool call (`parseToolCall`, :168), a retry loop with a
corrective nudge when the JSON is botched (`RETRY_NUDGE`, :35; loop
:62–89), the "did it even try to call a tool?" heuristic
(`looksLikeToolAttempt`, :185), and content-block flattening (:189).
The client — the agent loop (`runAgentLoop`) — sees none of it. That's
the textbook deep module: a huge amount of behavior, a tiny interface.
Deep walk in `02-emulation-hidden-behind-the-port.md`.

**Runner-up — the `VectorStore` port + `InMemoryVectorStore`.** Three
methods (`dimension`, `upsert`, `search`) hide cosine ranking, the
sort, and dimension enforcement (`in-memory-vector-store.ts`). buffr's
`PgVectorStore` swaps in behind the identical three methods. Deep walk
in `01-deep-provider-port.md`.

**Shallowest module — the per-agent `FixtureModelProvider`**
(`packages/agents/recommendation/src/fixture-provider.ts`, 18 lines,
copied into 5 packages). It's a shallow module by design — a test
double should be thin — but the *red flag* isn't shallowness, it's that
the same shallow module exists five times. The fix isn't to make it
deep; it's to make it *one*: hoist it into `@aptkit/runtime` (or a
`@aptkit/testing` package) and import it. Verified identical:
`diff recommendation/src/fixture-provider.ts rubric-improvement/src/fixture-provider.ts`
→ no differences.

No classitis worth naming. The packages are functions and small
classes, not towers of one-method objects.

---

## 3. information-hiding-and-leakage

Find decisions known in two modules that force them to change together.

This is where AptKit's real findings are. Three leaks, ranked:

```
  Leak 1 — embedding dimension (the worst)

  ┌─ pipeline.ts:23 ──────────────┐  embedder.dimension
  │ assertWiring: embedder == store│  !== store.dimension
  └────────────────────────────────┘
  ┌─ in-memory-vector-store.ts:37 ┐  vector.length
  │ assertDimension: vec == store  │  !== this.dimension
  └────────────────────────────────┘
  ┌─ conversation-memory.ts:62 ───┐  embedder.dimension
  │ ctor guard: embedder == store  │  !== store.dimension
  └────────────────────────────────┘
       same invariant, three homes, three error strings
```

**Leak 1 — dimension reconciliation.** The rule "embedder dim must
equal store dim" is written three times with three different error
messages. `memory` even duplicates the *pipeline's* check rather than
calling `assertWiring`. The knowledge ("these two numbers must agree")
crosses three modules. Fix: one `assertWiring(embedder, store)` exported
from `@aptkit/retrieval`, called by all three. The per-vector length
check inside the store (`:37`) is legitimately separate — that's
runtime input validation, not wiring — but the two *wiring-time* checks
(`pipeline.ts:23`, `conversation-memory.ts:62`) are the same decision
and should share one home. See `04-guard-rails-as-information-hiding.md`.

**Leak 2 — the metadata-filter workaround.** Both the search tool
(`search-knowledge-base-tool.ts:88`) and memory recall
(`conversation-memory.ts:94`) over-fetch then post-filter, because the
`VectorStore` port has no `filter` argument. Each picks its own
multiplier (`topK * 4` in the tool; `Math.max(k * 4, 20)` in memory).
The fact that "the store can't filter by metadata, so over-fetch" is
known in two places, with two magic numbers. The leak is the port's
*absence*: a missing capability forces the workaround upward. Fix
direction in `03-contract-as-the-product.md`.

**Leak 3 — the `kind: 'memory'` tag convention.** The string
`'memory'`, the id format `memory:<convId>:<n>`, and the
"`meta.kind === kind` to recall" rule are coordinated across
`conversation-memory.ts` (writes the tag, :84) and `memory-tool.ts`
(reads recalls). This one is contained — both live in `@aptkit/memory`
and the default is a single constant (`DEFAULT_KIND`, :41) — so it's a
mild leak, not a load-bearing one. Named for completeness.

No temporal decomposition worth flagging (modules are organized by
capability, not by execution phase).

---

## 4. layers-and-abstractions

Find pass-through methods/variables and adjacent layers offering the
same abstraction.

Mostly clean. The pipeline is a genuine layer over the contracts:
`indexDocument` does chunk → embed → upsert (`pipeline.ts:32`),
`queryKnowledgeBase` does embed → search (`:50`) — each adds real work,
not a forward. `createRetrievalPipeline` (`:73`) binds a validated
wiring and returns closures; that's a thin layer but it earns its place
by running `assertWiring` once at construction so callers can't index
into an unsearchable store.

**One pass-through worth naming:** `ContextWindowGuardedProvider`
(`packages/providers/local/src/context-window-guard.ts:57`) is a
decorator (the component is the wrapped provider, the wrapper is the
guard) — on the happy path it estimates tokens then calls
`this.provider.complete(request)` and returns the result unchanged
(:69). That *is* a pass-through on success. But it's the right kind:
the wrapper exists to throw `ContextWindowExceededError` before a doomed
local call (:67), and the fallback chain catches that and moves to the
next provider. The pass-through is the cost of the decorator pattern,
and the decorator buys a real capability (cheap pre-flight rejection).
Not a finding — a justified forward.

No two adjacent layers offering the same abstraction. The provider
adapters, the fallback chain, and the context guard each answer a
different question (which vendor / which order / does it fit?).

---

## 5. pull-complexity-downward

Find knobs pushed up to callers that the module had enough information
to decide itself.

AptKit is good at this — the contracts decide most things and expose
few knobs. Two knobs are worth examining, and the verdict differs:

**`minTopK` on the search tool** (`search-knowledge-base-tool.ts:40`,
:51). This is complexity *correctly* pushed down, then re-exposed as an
opt-in. The module owns the default (floor = 1, i.e. off) and the reason
to raise it ("stop a weak local model from starving its own retrieval by
passing top_k: 1"). The caller can override, but doesn't have to think
about it. Right call — this is the module owning a decision and offering
an escape hatch, not dumping a knob upward. See
`04-guard-rails-as-information-hiding.md`.

**`charsPerToken` on the context guard**
(`context-window-guard.ts:52`, default 3). This is a knob the module
mostly could own. The token estimate is `text.length / charsPerToken`
(`estimateTextTokens`, :100) — a heuristic. Exposing the divisor lets a
caller tune accuracy per model, which is defensible, but the default 3
is doing all the real work and no caller in the repo overrides it. Mild:
the knob is cheap and harmless, but it's complexity the caller shouldn't
usually have to see. Leave it; it's a reasonable seam for future
model-specific tuning.

**`maxToolCallAttempts` on Gemma** (`gemma-provider.ts:31`, default 2).
Correctly owned: the module picks 2, clamps to ≥1 (:49), and the caller
never has to know the emulation retries at all.

---

## 6. errors-and-special-cases

Find scattered exception handling and special cases a different
definition would erase.

Error handling here is notably disciplined — errors are mostly
*defined out* rather than caught everywhere.

**Defined out (best):** cosine similarity returns 0 for a zero-length
vector "to avoid NaN" (`in-memory-vector-store.ts:46`, :56) — a special
case erased by the definition, so no caller branches on it.
`queryKnowledgeBase` returns `[]` when the embedder yields no vector
(`pipeline.ts:57`) rather than throwing. `RagQueryAgent.answer` returns
a `FALLBACK_ANSWER` constant when `finalText` is empty
(`rag-query-agent.ts:82`) instead of surfacing an empty string.

**Masked low (good):** the agent loop wraps each tool call in try/catch
and feeds the error back to the model as a `tool_result` with
`isError: true` (`run-agent-loop.ts:163–186`) — one catch site, errors
become data the model can react to, not exceptions that unwind the loop.

**Aggregated (good):** `FallbackModelProvider` collects every failed
attempt and throws one `ProviderFallbackError` listing all of them
(`fallback-provider.ts:16`, :88) — N provider failures become one
error with the full trail, not N scattered throws.

**Thrown loud, deliberately:** the dimension checks (lens 1/3) and
`FixtureModelProvider` exhaustion (`fixture-provider.ts:15`) throw hard.
Correct — these are wiring/test bugs, not runtime inputs; failing loud
at the boundary is the move.

The one wrinkle: abort handling appears in three styles —
`signal?.throwIfAborted()` (`run-agent-loop.ts:99`), an `isAbortError`
helper checking both `DOMException` and `Error` name
(`fallback-provider.ts:92`), and an inline `instanceof DOMException`
check (`run-agent-loop.ts:219`). Same concept (is this an abort?), three
spellings. Minor consistency leak; one shared `isAbortError` would erase
it. Listed again under lens 7 (consistency).

---

## 7. readability (names · comments · consistency · obviousness)

Four facets, ranked list per facet.

**Names — strong.** The vocabulary is precise and consistent with the
domain: `EmbeddingProvider`, `VectorStore`, `VectorChunk`, `VectorHit`,
`assertWiring`, `RETRY_NUDGE`, `looksLikeToolAttempt`. No `data`, `obj`,
`tmp`, or `manager`. `GemmaChatTransport` names the injected seam
exactly. The one borderline name: `kind` (`conversation-memory.ts`) is
generic, but it's scoped tightly and documented as a partition tag, so
it reads fine in context.

**Comments — strong, and doing the right job.** The interface comments
carry *why*, not *what*: `contracts.ts:1–5` explains that the pipeline
never names a vendor; `:28–32` explains the one-way-door dimension rule;
`search-knowledge-base-tool.ts:101–104` explains why a hallucinated
filter key is ignored rather than applied. These are the comments only a
comment could carry — the rationale isn't in the code. No restate-the-
code noise found.

**Consistency — two small dings.**
  1. Abort detection in three styles (see lens 6).
  2. `minTopK` is clamped with `Math.max(1, ...)` (`:51`) and so is
     `maxToolCallAttempts` (`gemma-provider.ts:49`) — same idiom, good
     — but `recall`'s over-fetch uses `Math.max(k * 4, 20)`
     (`conversation-memory.ts:94`) while the search tool uses bare
     `topK * 4` (`search-knowledge-base-tool.ts:88`). Two conventions
     for "over-fetch before post-filter."

**Obviousness — one "huh?" worth flagging.** In `GemmaModelProvider`,
the retry only fires when `looksLikeToolAttempt(raw)` is true — i.e.
the text contains a `{` (`gemma-provider.ts:86`, :185). That's a clever,
cheap heuristic, but it's non-obvious control flow: plain prose answers
deliberately skip the retry. The comment at :85 saves it ("plain prose
is a real answer"). Without that comment it'd be a surprise. Keep the
comment; it's load-bearing.

---

## 8. red-flags-audit (capstone)

Ousterhout's red flags as a checklist, marked against this repo, sorted
by severity. This is the actionable index.

```
  RED FLAG                     VERDICT   WHERE / FIX
  ───────────────────────────  ────────  ──────────────────────────────
  Information leakage           FIRES     dimension rule in 3 files
                                          (pipeline.ts:23,
                                          in-memory-vector-store.ts:37,
                                          conversation-memory.ts:62)
                                          → one shared assertWiring
  ───────────────────────────  ────────  ──────────────────────────────
  Same knowledge edited twice   FIRES     FixtureModelProvider copied
                                          into 5 agent packages
                                          (agents/*/src/fixture-provider.ts)
                                          → hoist to @aptkit/runtime
  ───────────────────────────  ────────  ──────────────────────────────
  Conjoined / missing predicate FIRES     metadata filter absent from
                                          VectorStore port → over-fetch
                                          duplicated in 2 files
                                          (search-knowledge-base-tool.ts:88,
                                          conversation-memory.ts:94)
                                          → add optional filter to port
  ───────────────────────────  ────────  ──────────────────────────────
  Inconsistency                 MINOR     abort detection in 3 styles
                                          → one shared isAbortError
  ───────────────────────────  ────────  ──────────────────────────────
  Avoidable config exposed up   MINOR     charsPerToken on context guard
                                          (context-window-guard.ts:52)
                                          → acceptable seam, leave it
  ───────────────────────────  ────────  ──────────────────────────────
  Shallow module                N/A*      FixtureModelProvider is thin by
                                          design (test double); the flag
                                          is the duplication, not depth
  ───────────────────────────  ────────  ──────────────────────────────
  Classitis                     DOESN'T   no one-method-object towers
  Pass-through method/variable  DOESN'T   context guard forwards on
                                          success, but earns its place
                                          as a decorator (lens 4)
  Temporal decomposition        DOESN'T   organized by capability
  Try/except everywhere         DOESN'T   errors defined out / masked
                                          low / aggregated (lens 6)
  Comment restates code         DOESN'T   comments carry why, not what
  Vague names                   DOESN'T   domain vocabulary throughout
```

**Top 3 fixes, ranked across the whole repo:**

1. **Collapse the dimension check to one `assertWiring`.** One fact,
   one home; deletes two of three copies. Lowest effort, clearest win.
2. **Hoist `FixtureModelProvider` into a shared package.** Deletes 4 of
   5 copies of an identical class; a replay-double bug currently needs
   five edits.
3. **Add an optional `filter` predicate to the `VectorStore` port.**
   Removes the over-fetch-then-post-filter workaround from two call
   sites (and lets buffr's `PgVectorStore` push the filter into SQL,
   where it belongs). Highest effort, highest architectural payoff.

The honest summary: this codebase's *deep modules are genuinely deep*
(Gemma, the contracts) and its *errors are genuinely well-handled*. The
debt is all one shape — a few decisions that escaped their module and
now live in two or three places. That's the cheapest kind of debt to
pay down, and the fixes above are mechanical, not architectural.

---

## See also

- `00-overview.md` — the map + the PATTERN VOCABULARY this guide owns
- `01-deep-provider-port.md` — the `ModelProvider` / retrieval ports
- `02-emulation-hidden-behind-the-port.md` — Gemma's hidden tool-call emulation
- `03-contract-as-the-product.md` — why the retrieval contracts are the deliverable
- `04-guard-rails-as-information-hiding.md` — minTopK, matchesFilter, dimension guards
- `05-injectable-transport-seam.md` — `GemmaChatTransport` and testability
- `06-capability-as-composition.md` — the RAG agent assembled from ports
- `../study-system-design/` — same seams at the architecture altitude
- `../study-testing/` — the fixture/replay double this audit references
- `../study-agent-architecture/` — the agent loop as a client of these ports
