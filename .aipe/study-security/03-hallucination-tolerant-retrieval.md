# Hallucination-tolerant retrieval

**Industry name(s):** defensive input handling for model-supplied arguments
· fail-soft tool parameters · **Type:** Project-specific control (a deliberate
hardening against weak-model output)

## Zoom out, then zoom in

A model calling a tool supplies the arguments — the `query`, the `top_k`,
the `filter`. Those arguments are model output, which means they're
untrusted, and with a weaker local model (Gemma emulating tool-calling)
they're also frequently *wrong*: a hallucinated filter key, a `top_k: 1`
that starves a multi-part question, raw text where JSON was expected. The
defense isn't to reject the model — it's to make the tool fail *soft*,
absorbing bad arguments without crashing or silently returning nothing.

```
  Zoom out — where defensive arg handling lives

  ┌─ Runtime layer ──────────────────────────────────────────┐
  │  runAgentLoop  →  parseAgentJson (defensive JSON parse)    │
  └──────────────────────────┬────────────────────────────────┘
                             │  model-supplied tool args
  ┌─ Retrieval layer ────────▼────────────────────────────────┐
  │  ★ search_knowledge_base handler ★                        │ ← we are here
  │     coerce query/top_k · minTopK floor · matchesFilter    │
  └──────────────────────────┬────────────────────────────────┘
                             │  pipeline.query(query, k)
  ┌─ Vector store ───────────▼────────────────────────────────┐
  │  InMemoryVectorStore (cosine) / buffr PgVectorStore        │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: two related controls. At the runtime, the **defensive parser**
(`parseAgentJson`) — model output → structured value without trusting the
format. At the retrieval tool, **fail-soft arguments** (`minTopK` +
`matchesFilter`) — bad model args don't break or empty the search. Both
answer the same question: *what happens when the model gives us garbage?*

## Structure pass

**Layers:** runtime parses the model's *structured output*; the retrieval
tool sanitizes the model's *tool arguments*. Same trust problem, two sinks.

**Axis — trust (of model output):** trace "is this value safe to use as
given?" — the answer is *no* at every model boundary, and each layer has a
coercion step that makes it safe.

```
  Two boundaries, same untrusted source

  model output ──┬─► [runtime]  parseAgentJson  ─► validated value
                 │     (fenced? substring? throw)
                 └─► [retrieval] sanitize args   ─► safe query/topK/filter
                       (coerce types · floor topK · tolerant filter)
```

**Seam:** the boundary is the function signature — `parseAgentJson(text)`
and the tool `handler(args)`. Everything before is model output; everything
after is a value the code can trust because it *made* it trustworthy.

## How it works

#### Move 1 — the mental model

You already do this with a `fetch()` response: you never trust `res.json()`
to be the shape you expect — you guard it, default missing fields, coerce
types, handle the parse failure. Here the "response" is the model's output,
and it's *more* hostile than an API: a weak model invents fields and forgets
constraints. The pattern is defensive deserialization — assume the worst
shape and recover.

```
  Fail-soft, three coercions

  args.query   →  string? keep : ""           (never undefined to search)
  args.top_k   →  positive int? keep : default ; then max(_, minTopK)
  args.filter  →  plain object? keep : drop    (arrays/garbage ignored)
                  └─ matchesFilter: absent keys ignored, never excludes
```

#### Move 2 — the step-by-step walkthrough

**The JSON parser strips, retries, scans, then throws.** `parseAgentJson`
never assumes the model returned clean JSON. It pulls JSON out of a markdown
fence if present, tries a direct parse, and on failure does a bounded
substring scan for the first `{`/`[` to the last `}`/`]` — then throws a
clear error rather than returning a half-parsed value.

```typescript
// packages/runtime/src/json-output.ts (parseAgentJson)
const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);   // unwrap fence
const candidate = (fence ? fence[1] : text).trim();
try { return JSON.parse(candidate); } catch { /* fall through */ }
// bounded scan: first {/[ to last }/]
const start = /* min index of '{' or '[' */;
const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
throw new Error('no parseable json in model output');
```

The wrapper `parseValidatedJson` turns the throw into a
`{ ok: false, error }` result, so the agent can retry the turn instead of
crashing on a malformed response — exactly what a weak local model needs.

**The tool coerces every argument before use.** The
`search_knowledge_base` handler treats each model-supplied arg as suspect:
`query` becomes `""` if it isn't a string, `top_k` falls back to the default
unless it's a positive number, `filter` is kept only if it's a plain object.

```typescript
// packages/retrieval/src/search-knowledge-base-tool.ts:78-85
const handler: ToolHandler = async (args) => {
  const query = typeof args.query === 'string' ? args.query : '';        // coerce
  const requestedTopK =
    typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
  const topK = Math.max(requestedTopK, minTopK);                          // floor
  const filter =
    args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)
      ? (args.filter as Record<string, unknown>)
      : undefined;                                                        // drop garbage
```

**`minTopK` is a floor against self-starvation.** A weak model sometimes
passes `top_k: 1`, which on a multi-part question retrieves one chunk and
misses the rest — the model starves its own answer. `minTopK`
(`search-knowledge-base-tool.ts:51`, `Math.max(1, options.minTopK ?? 1)`)
raises any too-small request up to a configured floor. The model can ask for
*more*, never for fewer than the floor.

**`matchesFilter` ignores hallucinated keys instead of excluding on them.**
This is the cleverest piece. A naive filter would treat `{textContains:
"x"}` as "keep only hits whose `textContains` equals `x`" — and since no
chunk *has* a `textContains` field, that wipes every result. Instead, a
filter key only excludes a hit that *has* that key with a different value;
keys absent from a chunk's metadata are ignored.

```typescript
// packages/retrieval/src/search-knowledge-base-tool.ts:101-106
function matchesFilter(hit: VectorHit, filter: Record<string, unknown>): boolean {
  // A filter key only excludes hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored, so a weak model's hallucinated
  // filter (e.g. {textContains: "x"}) can't silently wipe every result.
  return Object.entries(filter).every(
    ([key, value]) => !(key in hit.meta) || hit.meta[key] === value,
  );
}
```

The `!(key in hit.meta)` short-circuits to `true` for any field the chunk
doesn't carry — a hallucinated filter degrades to no filter, not to an empty
result set. And because filtering can drop hits, the handler over-fetches
(`fetchK = topK * 4`, `:88`) so a real filter can still return up to `topK`.

#### Move 2 variant — the load-bearing skeleton

The kernel is **type-coerce every arg + floor the dangerous one +
fail-soft the filter**:

- **The type coercions** — *drop them and a non-string `query` or a string
  `top_k` reaches `pipeline.query` and throws*, turning a model mistake into
  a crashed run.
- **The `minTopK` floor** — *drop it and `top_k: 1` silently degrades recall
  on multi-part questions;* the model starves itself and you get a confident
  wrong answer, the worst failure mode in RAG.
- **The absent-key-ignored filter rule** — *drop it (use naive equality) and
  one hallucinated filter key empties the result set,* and the model answers
  "I couldn't find anything" on a corpus that has the answer. This single
  boolean (`!(key in hit.meta) ||`) is the whole defense.
- **Hardening, not kernel:** the `* 4` over-fetch. It improves filtered
  recall but the fail-soft property holds without it.

The interview tell: naming the **absent-key-ignored rule** — most people
write the naive filter that fails closed-to-empty, and don't realize a
hallucinated key turns a correct corpus into a "no results" answer.

#### Move 3 — the principle

When your input source is a probabilistic model, validation isn't
accept/reject — it's *coerce and degrade gracefully*. Reject and the run
crashes on the model's bad day; accept blindly and a hallucination poisons
the result. The middle path — coerce types, floor the dangerous values, let
unknown constraints fall away — is what makes a weak model usable instead of
brittle. It's the `res.json()` guard, taken seriously because the "API"
lies.

## Primary diagram

```
  Hallucination-tolerant retrieval — the full picture

  ┌─ model output (untrusted) ─────────────────────────────────┐
  │  text + tool call: { query, top_k: 1, filter:{textContains}}│
  └──────────────────────────┬──────────────────────────────────┘
            parseAgentJson    │   (fence → parse → scan → throw)
                              ▼
  ┌─ search_knowledge_base handler ────────────────────────────┐
  │  query   = string? : ""                                     │
  │  topK    = max(top_k>0? top_k : default, minTopK)  ← floor  │
  │  filter  = plain object? : dropped                          │
  │  fetchK  = filter ? topK*4 : topK            (over-fetch)    │
  │  hits.filter(matchesFilter): absent key ⇒ kept  ← fail-soft │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─ vector store ─────────────────────────────────────────────┐
  │  pipeline.query(query, fetchK)  →  ranked hits → citations  │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

This is defensive deserialization (Postel's law — "be liberal in what you
accept") applied to model output, with one twist specific to RAG: the
failure you most want to avoid is the *silent* one. A crash is loud and gets
fixed; an empty result set from a hallucinated filter looks like "the corpus
doesn't have it" and produces a confidently wrong answer. The
absent-key-ignored rule and the `minTopK` floor both exist to turn silent
recall failures into degraded-but-present results. This pairs with the
allowlist (`01`) and loop bound (`02`): those defend against what the model
*does*; this defends against what the model *says*.

## Interview defense

**Q: The model passes a filter with a field that doesn't exist on any
chunk. What happens?**

Nothing bad — the hit is kept. `matchesFilter` only excludes a hit that
*has* that key with a different value; an absent key short-circuits to
"matches." A hallucinated filter degrades to no filter instead of wiping the
result set. Without that rule, a single invented key (`{textContains:"x"}`)
empties the results and the model answers "not found" on a corpus that has
the answer — the silent failure that's worse than a crash.

```
  naive equality:  no chunk has key → 0 results → wrong answer (silent)
  absent-key rule: no chunk has key → key ignored → real results
```

*Anchor: the absent-key-ignored rule turns a hallucinated filter into a
no-op, not an empty result.*

**Q: Why floor `top_k` instead of trusting the model's value?**

Because a weak model passes `top_k: 1` on a multi-part question and starves
its own retrieval — one chunk back, the rest of the answer missing. The
`minTopK` floor raises any too-small request to a configured minimum; the
model can ask for more, never fewer. It's a guard against the model
under-asking, the same way you'd clamp a user-supplied page size.

*Anchor: minTopK is a floor against self-starvation, not a cap.*

## See also

- `01-least-privilege-tool-policy.md` — the policy that grants this one tool
- `02-bounded-agent-loop.md` — the loop that retries on a parse failure
- `audit.md` lens 3 — input validation across all sinks
- `study-ai-engineering` — the RAG pipeline this hardens
