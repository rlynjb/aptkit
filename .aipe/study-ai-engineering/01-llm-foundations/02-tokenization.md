# Tokenization — text becomes tokens (and AptKit only estimates)

**Industry names:** tokenization, BPE / subword encoding, token counting · *Industry standard*

## Zoom out, then zoom in

The model doesn't see characters — it sees tokens. Before any prompt reaches the
weights, the vendor splits your text into integer tokens; after, it emits
integer tokens that get decoded back to text. AptKit lives entirely on the text
side of that boundary and pays for what happens on the token side. Here's where
the token boundary sits.

```
  Zoom out — where tokens enter the picture

  ┌─ AptKit (text-side) ────────────────────────────────────────────┐
  │  prompts, messages, tool schemas — all plain strings             │
  │  ★ local context guard: ESTIMATES tokens (chars/3) ★ ←THIS CONCEPT│
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  request crosses the wire as text
  ┌─ Provider / vendor (token-side) ─▼────────────────────────────────┐
  │  tokenizer: text → token ids → weights → token ids → text         │
  │  returns REAL counts in response.usage (estimated: false)         │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: a token is a chunk of text — usually a word-piece, roughly 4 characters
of English on average. "tokenization" might be one token; "anomaly" might be two.
The model's context window and your bill are both measured in tokens, not
characters. Here's the honest part: **AptKit does not run a real tokenizer.** It
never sees token ids. It does one cheap thing — a `chars / 3` estimate in the
local context guard — and otherwise trusts the real counts the provider returns.

## Structure pass

**Layers.** Two, split by who counts tokens. The *text layer* (AptKit) holds
strings and, when it must guess a size, divides character length by a constant.
The *token layer* (the vendor) runs the actual tokenizer and returns exact
counts.

**Axis — guarantees: how accurate is the token count at each layer?** Trace it.
At the text layer the answer is "best-effort estimate, deliberately conservative"
(`charsPerToken = 3`, lower than real English so it over-counts and errs toward
caution). At the token layer the answer is "exact, ground truth"
(`estimated: false` on the usage the provider returns). The guarantee strengthens
as you cross into the vendor.

**Seam.** The seam is the wire: text goes out, exact counts come back. AptKit
estimates *only before* the call, when it has no real count yet (to decide
whether a local model's context window will overflow). After the call, it
discards its estimate and uses the provider's real numbers.

## How it works

You've truncated a string to fit a database column: `text.slice(0, 255)`. Token
limits are the same problem one layer up — you have a budget measured in tokens,
and you need to know if your text fits *before* you spend the call. The catch:
you can't count tokens exactly without the tokenizer, so AptKit approximates.

### Move 1 — the mental model

Tokenization is a lossy-to-you mapping: text → integers you never see. The only
two things AptKit cares about are *how many* tokens (for budgets and cost) and
where they come from (estimate vs. ground truth).

```
  Tokenization — and where the count comes from

   "get anomaly context"
        │
        │  vendor tokenizer (subword/BPE) — AptKit never runs this
        ▼
   [ get | anomaly | context ]   ← ~3 tokens (≈ 4 chars each)
        │
        ├─ BEFORE the call: AptKit GUESSES  →  ceil(19 chars / 3) = 7  (estimate)
        └─ AFTER the call:  vendor REPORTS  →  usage.inputTokens     (exact)
```

The estimate and the truth disagree (7 vs ~3 here) — and that's fine, because the
estimate exists only to answer one yes/no question: "will this overflow a local
model's context window?" Over-counting makes it skip the local model early rather
than blow the window. Conservative by design.

### Move 2 — the step-by-step walkthrough

#### The estimate: characters divided by a constant

AptKit's only "tokenizer" is one line of arithmetic. It flattens the request —
system prompt, every message, every tool's name + description + JSON schema —
into one string, then divides its length by `charsPerToken` (default 3) and
rounds up.

```
  estimateModelRequestTokens — the whole algorithm (pseudocode)

  text = join([
    request.system,                          // the system prompt
    ...messages.map(messageText),            // each turn's content
    ...tools.map(t => name + desc + schema)  // tool schemas count too!
  ], "\n")

  estimatedTokens = ceil(text.length / charsPerToken)   // charsPerToken = 3
```

Two non-obvious moves here. First, **tool schemas are included** — they're part
of what the model reads, so a request with 49 tool schemas (the query agent) has
a much bigger input than the user's question alone. Forget them and you'd
under-count badly. Second, **`charsPerToken = 3`, not 4.** Real English is closer
to 4 chars/token; using 3 makes the estimate *over*-count, which biases the guard
toward "this might overflow" — a safe direction for a hard context limit.

#### The ground truth: the provider returns it

After the call, the estimate is irrelevant — the response carries the real
counts. Both vendor adapters fill in `response.usage` from the SDK's own numbers
and mark them `estimated: false`.

```
  Where real counts come from (layers-and-hops)

  ┌─ AptKit ─────────┐  request (text)   ┌─ Vendor SDK ─────────┐
  │ generateStructured│ ────────────────►│ tokenizer + model    │
  │ / runAgentLoop    │                  │                      │
  │                   │◄──────────────── │ usage.input_tokens   │
  └─────────┬─────────┘  response +      │ usage.output_tokens  │
            │            real usage      └──────────────────────┘
            ▼
  emit model_usage trace { inputTokens, outputTokens, estimated: false }
            │
            ▼  the cost ledger sums these (06-token-economics.md)
```

Anthropic returns `input_tokens` / `output_tokens`; OpenAI returns
`prompt_tokens` / `completion_tokens`. Both get normalized into AptKit's
`ModelUsage` shape with `estimated: false`. The estimate's `estimated` flag would
be `true` — that boolean is how a reader tells a guessed count from a measured one.

### Move 3 — the principle

Know which numbers are measured and which are guessed, and never confuse them. An
estimate is fine for a *gate* (decide before you spend whether something fits); it
is not fine for a *bill* (charge based on a guess). AptKit draws that line exactly
right: it estimates only to decide whether to attempt a local-model call, and it
uses ground-truth counts for everything that matters downstream — cost, trace,
budget accounting. The `estimated` boolean carried alongside every count is the
honesty mechanism: a downstream reader always knows whether a number was measured.

## Primary diagram

The full picture — estimate before, ground truth after, and the one place each is
used.

```
  Tokens in AptKit — estimate vs. ground truth

  ┌─ BEFORE the call (text-side, AptKit) ────────────────────────────┐
  │  estimateModelRequestTokens(request, charsPerToken = 3)          │
  │    = ceil( (system + messages + tool schemas).length / 3 )       │
  │    → used ONLY by ContextWindowGuardedProvider to decide:        │
  │         estimated > (maxTokens - outputReserve) ? throw : proceed │
  │    → estimated: true                                             │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  wire
  ┌─ AFTER the call (token-side, vendor) ─▼────────────────────────────┐
  │  response.usage = real counts from the SDK                         │
  │    anthropic: input_tokens / output_tokens                         │
  │    openai:    prompt_tokens / completion_tokens                    │
  │    → estimated: false                                             │
  │    → summed by usage-ledger (06-token-economics.md)                │
  └──────────────────────────────────────────────────────────────────────┘

  REAL TOKENIZER: not exercised. AptKit never sees a token id.
```

## Implementation in codebase

**Use cases.** The estimate is reached for in exactly one place: the local
context-window guard, which wraps a local (on-device) provider and refuses calls
whose estimated input would overflow the model's window before wasting the call.
The ground-truth counts are reached for everywhere usage matters — every
`model_usage` trace event carries the provider's real numbers.

**The estimate**, `packages/providers/local/src/context-window-guard.ts:100-103`:

```
  packages/providers/local/src/context-window-guard.ts  (lines 100-103)

  export function estimateTextTokens(text: string, charsPerToken = 3): number {
    if (charsPerToken <= 0) throw new Error('charsPerToken must be greater than 0');
    return Math.ceil(text.length / charsPerToken);   ← the entire "tokenizer"
  }
       │
       └─ One division, rounded up. charsPerToken = 3 (not 4) makes it
          over-count, so the guard errs toward "won't fit" — the safe
          direction when the alternative is a context-overflow error.
```

What gets flattened into that text, `context-window-guard.ts:91-98`:

```
  packages/providers/local/src/context-window-guard.ts  (lines 91-98)

  const text = [
    request.system ?? '',                          ← system prompt
    ...request.messages.map(messageText),          ← every message turn
    ...(request.tools ?? []).map((tool) =>          ← tool schemas count too
      `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
  return estimateTextTokens(text, charsPerToken);
       │
       └─ Including tool schemas is the load-bearing detail. A query-agent
          request carries ~49 tool schemas; counting only the user message
          would under-estimate the real input by a wide margin.
```

**The ground truth**, `packages/providers/anthropic/src/anthropic-provider.ts:54-58`:

```
  packages/providers/anthropic/src/anthropic-provider.ts  (lines 54-58)

  usage: {
    inputTokens: response.usage.input_tokens,    ← Anthropic's real count
    outputTokens: response.usage.output_tokens,
    estimated: false,                            ← measured, not guessed
  },
```

The OpenAI adapter does the same with `prompt_tokens` / `completion_tokens`
(`packages/providers/openai/src/openai-provider.ts:69-75`), guarding for the case
where the SDK returns no usage at all (`usage` is left `undefined`).

## Elaborate

Real tokenizers are subword encoders — byte-pair encoding (BPE) or similar —
trained so common substrings become single tokens and rare ones split into
several. That's why "the" is one token and a long URL is many, and why the
~4-chars-per-token rule is an *average* that swings hard with content (code and
non-English text tokenize denser). AptKit's `chars / 3` doesn't model any of this;
it's a deliberately crude upper-bound-ish estimate whose only job is a yes/no gate.

The honest gap — **no real tokenizer is exercised** — matters for one reason: the
context guard can be wrong in both directions on real text (it over-counts plain
English, but could under-count token-dense content if you raised `charsPerToken`).
Because the guard's only consumer is local on-device models with hard small
windows, and because it biases conservative, the crudeness is acceptable. If
AptKit ever needed exact pre-flight counts (e.g. to pack a prompt to the last
token), it would need to call a real tokenizer such as `tiktoken` or the vendor's
token-counting endpoint — that's the Project Exercise below.

Adjacent: token *economics* — what those counts cost (`06-token-economics.md`);
the context guard's full role in production serving
(`../06-production-serving/`); and how prompt size is managed before it hits the
tokenizer, which is prompt-engineering territory
(`.aipe/study-prompt-engineering/`, *not yet generated*).

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case B — token counting is estimated, not real;
this makes it real.*

### Exercise — swap the estimate for a real tokenizer

- **Exercise ID:** `[C1.2]` Phase 1, tokenization
- **What to build:** Replace `estimateTextTokens`'s `chars / 3` with a real BPE
  count (e.g. `tiktoken` for the OpenAI path), behind the same function signature
  so `ContextWindowGuardedProvider` doesn't change. Keep the char estimate as a
  labelled fallback when no tokenizer is available for the model family.
- **Why it earns its place:** It makes the estimate/ground-truth distinction
  concrete and turns the one genuinely crude number in the foundations layer into
  a measured one — exactly the kind of "I closed a known gap" story interviews
  reward.
- **Files to touch:** `packages/providers/local/src/context-window-guard.ts`,
  its test, and a new dev dependency on a tokenizer.
- **Done when:** A unit test shows the real count for a known string matches the
  tokenizer's published value, and the guard still throws `ContextWindowExceededError`
  on an over-budget request.
- **Estimated effort:** `4hr–1d`

## Interview defense

**Q: How does your code count tokens before a model call?**
"It estimates — `chars / 3`, rounded up, over the system prompt, every message,
*and* every tool schema. I'd draw it:"

```
  (system + messages + tool schemas).length
        ÷ 3  (conservative; real English ≈ 4)
        = estimated input tokens   → gate, not a bill
```

"That's `estimateModelRequestTokens` in `context-window-guard.ts:91`. It's
deliberately a guess — its only job is deciding whether a local model's window
will overflow. The *real* counts come back from the provider in `response.usage`
with `estimated: false`. I never confuse the two."
*Anchor: estimate for the gate, ground truth for the bill.*

**Q: Why `/ 3` when English is closer to 4 chars per token?**
"To over-count. The estimate guards a hard context limit; if I'm going to be
wrong, I want to be wrong toward 'too big, skip the local model' rather than
'fits' followed by an overflow error. Conservative is the safe direction for a
gate." *Anchor: bias the estimate toward the failure that's cheaper to recover.*

## Validate

- **Reconstruct:** Write `estimateModelRequestTokens` from memory — what three
  things get concatenated, and the divide-and-ceil. Check
  `packages/providers/local/src/context-window-guard.ts:91-103`.
- **Explain:** Why are tool schemas included in the estimate? (They're part of
  what the model reads each turn; with ~49 query-agent tools, excluding them
  under-counts the input badly — `context-window-guard.ts:95`.)
- **Apply:** A request estimates at 30k tokens; the guard has `maxTokens: 32k`,
  `outputReserve: 768`. Does it proceed? (Available input = 32000 − 768 = 31232;
  30000 ≤ 31232, so yes — `context-window-guard.ts:80-88`.)
- **Defend:** Why is it acceptable that AptKit never runs a real tokenizer? (Its
  only token estimate feeds a conservative gate for local models; everything that
  bills or budgets uses the provider's exact `estimated: false` counts —
  `anthropic-provider.ts:54-58`.)

## See also

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — the tokens-in-tokens-out function these tokens flow through
- [06-token-economics.md](06-token-economics.md) — what these token counts cost
- [../06-production-serving/](../06-production-serving/) — the context guard in the fallback chain
