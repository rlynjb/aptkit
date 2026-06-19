# Sampling parameters — temperature, and only temperature

**Industry names:** sampling parameters, temperature / top-p / top-k, decoding controls · *Industry standard*

## Zoom out, then zoom in

The model emits a probability distribution over the next token; sampling
parameters decide how you pick from it. AptKit exposes exactly one of those
knobs — `temperature` — and plumbs it straight through to whichever vendor is
behind the contract. Here's where the knob lives.

```
  Zoom out — where the sampling knob sits

  ┌─ Caller (agent / structured gen / judge) ───────────────────────┐
  │  passes temperature?  →  request.temperature                    │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  ModelRequest { temperature? }
  ┌─ Runtime contract ─────────────▼──────────────────────────────────┐
  │  ★ request.temperature ★  ←── THIS CONCEPT (one optional field)    │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  conditionally forwarded
  ┌─ Adapter layer ────────────────▼──────────────────────────────────┐
  │  anthropic: ...(temp !== undefined ? { temperature } : {})         │
  │  openai:    ...(temp !== undefined ? { temperature } : {})         │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  if omitted →
  ┌─ Vendor default ───────────────▼──────────────────────────────────┐
  │  provider's own default temperature                               │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: temperature scales how sharp the next-token distribution is before
sampling. Low temperature (→0) makes the model nearly deterministic — it picks
the highest-probability token almost every time. High temperature (→1+) flattens
the distribution, so lower-probability tokens get picked more often: more varied,
more creative, less reliable. `top_p` and `top_k` are alternative ways to clip
the distribution — and AptKit exposes *neither*. One knob, honestly.

## Structure pass

**Layers.** Three: the *caller* (may set `temperature`), the *contract* (carries
it as one optional field), the *adapter* (forwards it conditionally to the SDK).

**Axis — control: who decides the sampling temperature?** Trace it down. At the
caller layer: usually nobody — most call sites leave it unset. At the contract:
it's just an optional number passing through. At the adapter: a ternary decides
*whether to forward it at all* — and if the caller didn't set it, the adapter
sends nothing and the **vendor's default wins**. So the control answer flips:
caller-or-nobody → vendor-default.

**Seam.** The seam is that ternary in each adapter:
`...(temperature !== undefined ? { temperature } : {})`. On one side, AptKit's
"I have no opinion" (undefined). On the other, the vendor's default. The
load-bearing decision is *not setting* temperature — letting the provider choose.

## How it works

You've used a `?? defaultValue` to mean "use mine if I gave one, else fall back."
Temperature handling is exactly that, expressed as a conditional spread: forward
the caller's value if present, otherwise send nothing and let the vendor's
default apply.

### Move 1 — the mental model

Temperature reshapes the distribution before the dice roll. Picture the same
next-token distribution at two temperatures:

```
  Temperature reshapes the next-token distribution

  logits → softmax(logits / T) → sample

  T → 0  (sharp):     ████████████ "increased"   ← almost always picks the top
                      ▏ "rose"                      token; near-deterministic
                      ▏ "spiked"

  T = 1  (flat-ish):  ██████ "increased"          ← lower-probability tokens get
                      ███ "rose"                     real chances; more varied
                      ██ "spiked"
```

Same model, same prompt, same logits — temperature alone decides whether you get
the safe top token nearly every time or a more adventurous spread. For a
classifier ("reply with one word") you want the sharp end. For brainstorming you
want the flat end.

### Move 2 — the step-by-step walkthrough

#### One field on the request

Temperature enters as a single optional number on `ModelRequest`. No `top_p`, no
`top_k`, no stop sequences — the contract carries the one knob the repo uses.

```
  ModelRequest — the sampling surface (pseudocode)

  request = {
    system?, messages, tools?, maxTokens?,
    temperature?,    // ← the ONLY sampling parameter in the contract
    signal?
  }
```

The boundary condition: if you reach for `top_p`, it's not there. That's not an
oversight to work around — it's the contract declining to promise a knob nothing
in the repo turns.

#### The adapter forwards it conditionally

Each adapter spreads `temperature` into the SDK call *only if it's defined*. This
is the crux: omitting it is meaningfully different from setting it to a number.

```
  Adapter forwarding (layers-and-hops)

  ┌─ AptKit request ─────┐                    ┌─ Vendor SDK call ───────┐
  │ temperature = 0      │ ─ defined? yes ──► │ { ..., temperature: 0 } │
  ├──────────────────────┤                    ├─────────────────────────┤
  │ temperature = undef  │ ─ defined? no  ──► │ { ... }  (no temp field)│
  └──────────────────────┘                    │   → VENDOR DEFAULT wins  │
                                              └─────────────────────────┘
```

Send `0` and you pin near-deterministic decoding. Send nothing and the vendor
picks (typically ~1.0 for chat models). AptKit's call sites overwhelmingly send
nothing — so in practice AptKit runs at the *provider default* temperature, by
omission, not by choice.

#### What that means for the reliability-sensitive paths

Here's the tension. The reliability-sensitive paths — the intent classifier
("reply with ONLY one word"), the rubric judge, structured generation — all *want*
low or zero temperature, because you want the same input to score the same way
twice. `generateStructured` and the rubric judge both *accept* a `temperature`
option and thread it through. But they default it to `undefined` — so unless a
caller passes `0`, those paths inherit the vendor's chattier default and lean on
**retry** (`04-structured-outputs.md`) to absorb the variance instead of
suppressing it at the source.

```
  The reliability gap, made concrete

  intent classifier / rubric judge / structured gen
        │ wants: temperature 0 (repeatable)
        │ gets:  undefined → vendor default (~1.0, varied)
        ▼
  variance shows up → absorbed downstream by parse + retry,
                      NOT by pinning temperature to 0
```

### Move 3 — the principle

Expose only the knobs your system actually turns, and be explicit about defaults.
AptKit exposes one sampling parameter because one is all it uses; promising
`top_p` and `top_k` it never sets would be a contract it doesn't keep. But the
flip side is a real lesson: *relying on the vendor default* for classifier and
structured paths trades determinism for a retry loop. That's a defensible choice
(retry also catches malformed JSON, which temperature 0 wouldn't), but it's a
choice — and naming it is the point.

## Primary diagram

The full path of the one knob, from caller to vendor default.

```
  temperature — the only sampling parameter, end to end

  ┌─ Caller ──────────────────────────────────────────────────────┐
  │  classifyIntent: (no temperature) → undefined                  │
  │  RubricJudge:    temperature?      → undefined unless set       │
  │  generateStructured: temperature?  → undefined unless set       │
  └───────────────────────────────┬─────────────────────────────────┘
                                   │  ModelRequest.temperature
  ┌─ Adapter ──────────────────────▼─────────────────────────────────┐
  │  anthropic-provider.ts:36   ...(temp !== undefined ? {temp} : {}) │
  │  openai-provider.ts:45      ...(temp !== undefined ? {temp} : {}) │
  └───────────────────────────────┬─────────────────────────────────┘
              defined ─────────────┤───────────── undefined
                  │                              │
                  ▼                              ▼
        SDK uses caller value          SDK uses VENDOR DEFAULT

  NOT in the contract: top_p, top_k, stop sequences, seed.
```

## Implementation in codebase

**Use cases.** Temperature is *accepted* by every structured path — `generateStructured`
threads `options.temperature` into the model call; `RubricJudge` exposes it as a
constructor option. But it's *set* almost nowhere: the intent classifier doesn't
pass it, and the agents that build rubric judges don't set it either, so the
effective temperature across the repo is the provider default.

**The contract field**, `packages/runtime/src/model-provider.ts:44`: a single
`temperature?: number` on `ModelRequest`. No companion `topP` or `topK`.

**Anthropic forwarding**, `packages/providers/anthropic/src/anthropic-provider.ts:36`:

```
  packages/providers/anthropic/src/anthropic-provider.ts  (line 36)

  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
       │
       └─ Conditional spread. If the caller set temperature, forward it; if
          not, send no temperature field at all and let Anthropic's default
          apply. Omission ≠ zero — this line is where "I have no opinion"
          becomes "the vendor decides."
```

**OpenAI forwarding**, `packages/providers/openai/src/openai-provider.ts:45`:

```
  packages/providers/openai/src/openai-provider.ts  (line 45)

  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
       │
       └─ Identical pattern. Both adapters agree: undefined means "don't
          send the field," which is the only way to actually get the
          vendor default rather than overriding it.
```

**Structured gen threads it through**,
`packages/runtime/src/structured-generation.ts:72`: inside the attempt loop, the
model call passes `temperature: options.temperature` — so a caller *can* pin it to
0 per structured call, but the option defaults to `undefined`.

**The classifier that wants 0 but doesn't set it**,
`packages/agents/query/src/intent.ts:17-23`: `classifyIntent` builds a request
with `maxTokens: 16` and a "reply with ONLY one word" system prompt — a textbook
temperature-0 use case — yet passes no temperature, inheriting the vendor default.

## Elaborate

Temperature, top-p (nucleus sampling), and top-k are three knobs on the same
mechanism: how much of the probability mass you let the sampler reach for.
Temperature rescales the whole distribution; top-p keeps the smallest set of
tokens whose probabilities sum to *p* and renormalizes; top-k keeps the *k*
highest and drops the rest. They compose, and most APIs expose all three. AptKit
exposes only temperature because that's the only one any call site would turn —
and even temperature is left to the vendor default in practice.

The deeper lesson is the interaction with the retry loop. Classic advice says
"set temperature 0 for classifiers and structured output." AptKit instead leaves
temperature alone and hardens the *parse* step with a retry-once nudge
(`04-structured-outputs.md`). That works because retry catches more than
nondeterminism — it also catches a model that wrapped JSON in prose or a markdown
fence, which temperature 0 wouldn't fix. So the two approaches aren't substitutes;
pinning temperature *and* keeping retry would be strictly more robust. The repo
ships the retry half.

Adjacent: structured outputs and the retry that absorbs sampling variance
(`04-structured-outputs.md`); the rubric judge that accepts temperature
(`../05-evals-and-observability/`); prompt-side determinism techniques like
few-shot anchoring live in prompt engineering (`.aipe/study-prompt-engineering/`,
*not yet generated*).

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case B — the knob exists but reliability paths don't
set it; this closes that.*

### Exercise — pin temperature 0 on the deterministic paths

- **Exercise ID:** `[C1.3]` Phase 1, sampling parameters
- **What to build:** Pass `temperature: 0` from the paths that need
  repeatability — `classifyIntent` and the agents that construct `RubricJudge` /
  call `generateStructured` for scoring. Keep it configurable, defaulting to 0
  for those paths only.
- **Why it earns its place:** It demonstrates you understand that omission means
  "vendor default," not "zero," and that classifier/judge reliability wants the
  sharp end of the distribution. The before/after eval (does the judge score the
  same input identically twice more often?) is a clean measurable win.
- **Files to touch:** `packages/agents/query/src/intent.ts`,
  the rubric-judge call sites in `packages/evals/` /
  `packages/agents/rubric-improvement/`, plus tests asserting the request carries
  `temperature: 0`.
- **Done when:** A test confirms `classifyIntent`'s request has `temperature: 0`,
  and a repeated-judgment eval shows reduced verdict variance.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How does your code control sampling, and what's the default?**
"One knob — `temperature`, an optional field on `ModelRequest`. No top-p, no
top-k; the contract only promises what the repo uses. The key detail is the
adapter forwards it *conditionally*:"

```
  temperature defined? ── yes ──► SDK gets it
                       ── no  ──► SDK gets nothing → VENDOR DEFAULT
```

"So when a call site omits it — which most do — we run at the provider's default
temperature. That's `anthropic-provider.ts:36` and `openai-provider.ts:45`."
*Anchor: omitting temperature is a choice — it hands control to the vendor.*

**Q: Your intent classifier wants deterministic one-word answers. Is temperature
set to 0?**
"No — and that's a gap. `classifyIntent` in `intent.ts:17` builds a one-word
classifier prompt but passes no temperature, so it inherits the vendor default.
The reliability is currently carried by the `parseIntent` heuristic that maps the
output back to a known label and defaults to `diagnostic` on anything unexpected,
not by pinning temperature. I'd set `temperature: 0` there."
*Anchor: the determinism is recovered downstream by a parser, not at the source.*

## Validate

- **Reconstruct:** Write the conditional-spread line both adapters use. Check
  `packages/providers/anthropic/src/anthropic-provider.ts:36` and
  `packages/providers/openai/src/openai-provider.ts:45`.
- **Explain:** Why does omitting `temperature` differ from setting it to `0`?
  (Omitting sends no field, so the vendor default applies; `0` pins
  near-deterministic decoding — `anthropic-provider.ts:36`.)
- **Apply:** You want the rubric judge to score identically across runs. Which
  knob, set where? (`temperature: 0` via `RubricJudgeOptions` — it threads to
  `generateStructured`'s model call at `structured-generation.ts:72`.)
- **Defend:** Why expose only `temperature` and not `top_p` / `top_k`? (Nothing
  in the repo turns them; a contract that promises unused knobs is one every
  adapter and fixture must honor for no benefit — `model-provider.ts:44`.)

## See also

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — the function whose output this knob shapes
- [04-structured-outputs.md](04-structured-outputs.md) — the retry loop that absorbs sampling variance
- [07-heuristic-before-llm.md](07-heuristic-before-llm.md) — the classifier that wants temperature 0
- [08-provider-abstraction.md](08-provider-abstraction.md) — the adapters that forward the knob
