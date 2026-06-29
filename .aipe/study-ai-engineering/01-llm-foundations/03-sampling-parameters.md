# Sampling parameters — the knobs on the next-token guess

**Subtitle:** temperature / top-p / top-k · shaping the output distribution · *Industry standard*

## Zoom out, then zoom in

Before you tune anything, see where the "knobs" live: they ride along with the
request, get passed to the model, and do nothing in your code at all.

```
  Zoom out — where sampling knobs travel

  ┌─ Capability ────────────────────────────────────────────────┐
  │  classifyIntent / rubric judge — wants ONE deterministic ans │
  └───────────────────────────┬─────────────────────────────────┘
                              │ ModelRequest { temperature? }
  ┌─ Runtime contract ────────▼─────────────────────────────────┐
  │  complete(request) — carries temperature through untouched  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ HTTP / SDK
  ┌─ The model ───────────────▼─────────────────────────────────┐
  │  ★ sampler ★  reshapes the next-token probability cloud     │
  └──────────────────────────────────────────────────────────────┘
```

Every time the model picks the next token, it actually produces a *probability
distribution* over the whole vocabulary — thousands of candidate tokens, each
with a likelihood. Sampling parameters decide how that cloud gets collapsed into
one choice. `temperature` flattens or sharpens the cloud; `top-p`/`top-k` chop
off the unlikely tail before picking. Low temperature → it almost always grabs
the single most-likely token (near-deterministic). High temperature → it gambles
on rarer tokens (creative, sometimes wrong).

## Structure pass

**Layers.** Capability (decides it needs determinism) → request field
(`temperature`) → provider adapter (passes it down or ignores it) → sampler
(inside the model).

**Axis — determinism.** Trace how repeatable the output is. The capability wants
high repeatability for classifiers; it expresses that as a low/zero temperature
*intent*; the adapter forwards `temperature` only if set; the sampler honors it.
In aptkit, most call sites **don't set temperature at all** — determinism comes
from the *task being narrow* plus *fixture replay in tests*, not a hard lock.

**Seam.** The flip is at the request boundary: above it, "I want one stable
answer" is a design decision; below it, it's a float the sampler obeys. aptkit
leaves that float mostly unset and leans on the task shape instead — an honest
gap, not a feature.

## How it works

### Move 1 — the mental model

Think of `Math.random()` versus a fixed seed. With no constraint, repeated calls
wander. Sampling is the model's `random()`, and `temperature` is how wide it's
allowed to wander. Temperature 0 is "always take the top choice" — as close to a
pure function as the model gets.

```
  Temperature reshaping the next-token cloud

  low temp (≈0)                 high temp (≈1.0)
  ┌───────────────┐             ┌───────────────┐
  │ ▓▓▓▓▓▓▓ "It"  │ ◄ peaked    │ ▓▓▓ "It"      │ ◄ flat
  │ ▓ "Honestly"  │   pick top  │ ▓▓ "Honestly" │   pick anything-ish
  │ . "Frankly"   │   always    │ ▓▓ "Frankly"  │
  └───────────────┘             └───────────────┘
  repeatable, "boring"          varied, "creative", riskier
```

### Move 2 — the moving parts

**The knob is just an optional field.** aptkit models temperature as one optional
number on the request. From `packages/runtime/src/model-provider.ts:39`:

```ts
export type ModelRequest = {
  system?: string;
  messages: ModelMessage[];
  tools?: ModelTool[];
  maxTokens?: number;
  temperature?: number;   // ← optional. unset means "provider default", NOT zero
  signal?: AbortSignal;
};
```

```
  temperature?  →  set: sampler obeys it
                →  unset: provider's own default (often ~0.7–1.0)
```

The trap: `temperature?` being optional means "I didn't say" — and "I didn't say"
is *not* the same as deterministic. The Anthropic adapter, for instance, only
sends temperature when it's defined (`anthropic-provider.ts:36`).

**The classifier wants one word, not low temperature.** The clearest "I need
determinism" site in the repo is intent classification — and notice how it gets
there. From `packages/agents/query/src/intent.ts:12`:

```ts
const response = await model.complete({
  system: 'Classify the user query as exactly one word: monitoring …',  // ← narrow task
  messages: [{ role: 'user', content: query }],
  maxTokens: 16,                                                         // ← can't ramble
  signal: options.signal,
});                                                                      // ← NO temperature set
return parseIntent(text);                                               // ← forgiving parser anyway
```

```
  How aptkit gets near-deterministic WITHOUT a temp lock

  narrow task ─┐
  maxTokens:16 ─┼─► output space so small that sampling barely matters
  forgiving    ─┘   + parseIntent() collapses fuzz to one of 3 labels
  parser
```

Determinism here is *engineered into the task*: a one-word answer cap of 16
tokens, plus `parseIntent` keyword-matching the result down to one of three
labels. Even a slightly varied phrasing lands on the same intent. That's robust,
but it is **not** a temperature lock — and aptkit does not set one.

**The structured/judge path threads temperature but doesn't force it.**
`generateStructured` and the rubric judge accept `temperature` and pass it
through (`structured-generation.ts:72`, `rubric-judge.ts:77`), but it defaults to
`undefined`. So even the JSON-grading paths rely on task narrowness + retry +
fixture replay, not a hard determinism setting. `not yet exercised`: explicit
temperature tuning across call sites.

### Move 3 — the principle

You get reliable output two ways: clamp the *sampler* (temperature 0) or clamp the
*task* (tiny output space + a forgiving parser). aptkit chose the second. It's
cheaper to reason about and survives a provider that ignores temperature, but be
honest in interviews — the determinism is a property of the task and the tests,
not a config value.

## Primary diagram

```
  Two routes to a stable answer

  Route A — clamp the sampler          Route B — clamp the task (aptkit)
  ┌─────────────────────┐              ┌──────────────────────────┐
  │ temperature: 0      │              │ tiny prompt, maxTokens:16 │
  │ sampler always tops │              │ + parseIntent() squeeze  │
  └─────────┬───────────┘              └────────────┬─────────────┘
            ▼                                       ▼
   deterministic by config             deterministic by design + fixtures
   (aptkit: mostly UNSET)              (aptkit: this is what's real)
```

## Elaborate

Temperature scales the logits before softmax; top-k keeps only the k highest-
probability tokens; top-p (nucleus) keeps the smallest set whose cumulative
probability exceeds p. Production classifiers and JSON generators almost always
run at temperature 0 in the wild. aptkit's choice to lean on task shape + fixture
replay is pragmatic for a local-first, fixture-tested repo, but a real gap if you
ship to a vendor that defaults hot. Read `04-structured-outputs.md` next — the
retry loop there is the safety net that lets aptkit get away with not locking
temperature.

## Project exercises

### Make the classifier explicitly deterministic
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** add `temperature: 0` to the `classifyIntent` request and add
  a test that runs the same query N times against a fixture provider asserting one
  stable label.
- **Why it earns its place:** closes the honest gap — turns "deterministic by luck
  of task shape" into "deterministic by config," and teaches the difference.
- **Files to touch:** `packages/agents/query/src/intent.ts`,
  `packages/agents/query/test/intent.test.ts`.
- **Done when:** the request carries `temperature:0` and the repeat test passes.
- **Estimated effort:** `<1hr`

### Audit every call site for an unset temperature
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a grep-driven note listing each `model.complete` / structured
  call and whether it sets temperature, then a one-paragraph recommendation.
- **Why it earns its place:** surfaces the repo-wide reliance on task shape and
  makes the gap explicit — the kind of audit a staff engineer runs before a vendor
  swap.
- **Files to touch:** read across `packages/agents/*/src`, `packages/runtime/src`,
  `packages/evals/src`; write nothing into code.
- **Done when:** you can name every deterministic-intent call site and its temp.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "Does aptkit use temperature 0 for its classifier?"**
No — and that's the interesting part. It gets near-determinism from a one-word
task, a 16-token cap, and a forgiving `parseIntent` parser, plus fixture replay in
tests. There's no temperature lock anywhere in most call sites.

```
  expected:  temperature:0
  actual:    maxTokens:16 + narrow prompt + parseIntent() + fixtures
             (temperature: unset)
```
Anchor: *the determinism is in the task and the tests, not a config float.*

**Q: "When would you reach for low temperature?"**
Classifiers, structured/JSON output, anything you'll parse or assert on. High
temperature is for ideation and copy. The rule: if a downstream parser depends on
it, clamp it.

```
  parse/assert downstream?  ──► temperature low (clamp the sampler)
  human reads it for ideas? ──► temperature high (let it wander)
```
Anchor: *if code reads the output, sample cold.*

## See also

- `04-structured-outputs.md` — the retry net that compensates for hot sampling
- `07-heuristic-before-llm.md` — `parseIntent`, the forgiving squeeze used here
- `01-what-an-llm-is.md` — the function these knobs tune
