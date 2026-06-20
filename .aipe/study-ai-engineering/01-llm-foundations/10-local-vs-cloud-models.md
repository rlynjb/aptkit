# Local vs cloud models — the open-weights tradeoff

**Industry names:** local inference, open-weights models, on-device LLMs · *Industry standard*

## Zoom out, then zoom in

There are two ways to get a model: rent one or run one. Rent a frontier model
(Anthropic `claude-sonnet`, OpenAI `gpt-4.1`) and you pay per token, your data
leaves the box, and you get a model that's smart and fast. Run an open-weights
model (Gemma2:9b over Ollama on your own hardware) and the per-call cost is zero,
the data never leaves, you work offline — but a 9b model is markedly weaker,
especially at tool-calling and structured output. AptKit puts both behind the
*same* `ModelProvider` port, so the choice is a constructor argument, not an
architecture. Here's the shape.

```
  Zoom out — one port, a local arm and a cloud arm

  ┌─ Core: runtime + agents (vendor-FREE) ──────────────────────────┐
  │  runAgentLoop · QueryAgent · RagQueryAgent · usage-ledger        │
  │  import only ModelProvider                                       │
  └─────────────────────────────┬───────────────────────────────────┘
                                │ complete(request)
  ┌─ Port: ModelProvider ───────▼───────────────────────────────────┐
  │  { id, defaultModel?, complete() }                              │
  └──┬───────────────────────────────────────────┬──────────────────┘
     │ implements (LOCAL arm)                     │ implements (CLOUD arm)
  ┌──▼─────────────────────────────────┐   ┌──────▼──────────────────┐
  │ ★ GemmaModelProvider ★             │   │ Anthropic / OpenAI      │
  │ id=gemma · gemma2:9b · Ollama      │   │ claude-sonnet · gpt-4.1 │
  │ (wrap in ContextWindowGuarded-     │   │ network · per-token     │
  │  Provider — small window, can't    │   │ smarter · native tools  │
  │  buy a bigger one)                 │   └─────────────────────────┘
  └────────────────────────────────────┘
```

Zoom in: this isn't a new abstraction — it's `08-provider-abstraction.md`'s port
with a *local* adapter plugged into it. What's new is the *decision*: when do you
reach for the local arm? The honest answer is a tradeoff table across five axes —
cost, privacy, latency, capability, offline — and a 9b model loses the capability
axis hard. That loss is *why* the Gemma adapter has to work harder than the cloud
ones (it emulates tool-calling; see `../04-agents-and-tool-use/07-emulated-tool-calling.md`).
This file is about reading the table and knowing which arm to wire in.

## Structure pass

**Layers.** Three, same as the cloud case: the *core* (codes against
`ModelProvider`), the *port* (`ModelProvider`), the *adapters*. The local arm adds
one more layer *below* the adapter — the **local runtime** (Ollama) and the
**hardware** it runs on. The cloud arm's bottom layer is someone else's data
center.

**Axis — where does the data go, and who pays per call?** Trace one request. Local:
core → port → `GemmaModelProvider` → `http://localhost:11434` → your GPU. It never
crosses the network boundary; the marginal cost is electricity. Cloud: core → port
→ Anthropic adapter → HTTPS → Anthropic's servers, billed per token, your prompt on
their wire. The boundary the request does or doesn't cross is the whole tradeoff:
local keeps the data and the dollars on-box; cloud trades both for a smarter, faster
model.

**Seam.** The seam is the same `implements ModelProvider`. Because Gemma satisfies
the identical port, it's not just swappable — it's *composable*: wrap it in
`ContextWindowGuardedProvider` (a decorator over the port), or drop it first in a
`FallbackModelProvider` chain. The local-vs-cloud decision lives entirely behind
this seam; nothing in the agent loop knows which arm it's talking to.

## How it works

You've made this call before without a model in it: self-host Postgres on a box you
own, or rent RDS. Self-hosting is zero marginal cost, full data control, and your
problem when it breaks; renting is per-hour billing, someone else's ops, and more
capability than you'd provision yourself. Local vs cloud models is that decision
aimed at inference — and the kicker is that the rented model is also *smarter*, not
just easier.

### Move 1 — the mental model

Same port, two arms. The core plugs into the port; the local arm runs on your
hardware, the cloud arm runs on theirs. The core can't tell them apart — but you,
choosing which to construct, are trading five axes at once.

```
  The five-axis tradeoff — read top to bottom, pick an arm

  axis          LOCAL (Gemma2:9b / Ollama)      CLOUD (sonnet / gpt-4.1)
  ───────────   ─────────────────────────────   ─────────────────────────
  cost      →   ● zero per-call (after HW)       ○ per-token, forever
  privacy   →   ● data never leaves the box      ○ prompt crosses the wire
  offline   →   ● works with no network          ○ needs the network
  latency   →   ◄ no network, but slow 9b ►       ◄ network + fast big model ►
  capability→   ○ weaker — esp. tools/JSON       ● frontier-smart
```

`●` = wins the axis, `○` = loses it, `◄ ►` = it depends. Local sweeps cost,
privacy, and offline; cloud takes capability outright; latency is genuinely a
wash — local skips the network but a 9b model is slow to think, cloud pays network
but the big model is fast. The capability gap is the one that bites: a 9b model is
worse at exactly the things an agent needs — calling tools and emitting clean JSON.

### Move 2 — the step-by-step walkthrough

#### Step 1 — the local adapter is just another `ModelProvider`

`GemmaModelProvider implements ModelProvider`. It declares `id = 'gemma'`, a
`defaultModel` of `gemma2:9b`, and `complete()` — same three members as the
Anthropic adapter. The difference is what `complete()` talks to: not a vendor SDK
over HTTPS, but Ollama's `POST /api/chat` on `http://localhost:11434`.

```
  GemmaModelProvider — the local arm, same port shape

  class GemmaModelProvider implements ModelProvider {
    id = 'gemma'
    defaultModel = options.model ?? 'gemma2:9b'      ← the open-weights model
    complete(request) {
      messages = buildMessages(request)               ← tools rendered into text
      resp = await this.chat({ model, messages, stream:false })  ← Ollama /api/chat
      return toResponse(...)                          ← Ollama shape → neutral
    }
  }
  └─ this.chat defaults to POST http://localhost:11434/api/chat,
     but is INJECTABLE (GemmaChatTransport) so tests feed recorded replies.
```

The boundary condition: because the transport is injectable, the local arm is just
as testable as the cloud arm — a recorded Gemma reply stands in for a running
Ollama, no GPU in CI.

#### Step 2 — wrap it in the context-window guard (matters MORE for local)

A 9b model has a smaller context window than a frontier model, and you can't fix
that by paying more — there's no bigger SKU to rent. So the local arm gets wrapped
in `ContextWindowGuardedProvider`, which estimates the request's input tokens and
*refuses before delegating* if they'd overflow the budget.

```
  Guard wrapping Gemma — fail fast, on-box, before the model chokes

  request ──► ContextWindowGuardedProvider.complete()
                  │ estimate = estimateContextWindow(request, {maxTokens})
                  ▼
            estimate.ok ?
              ├─ NO  → throw ContextWindowExceededError   ← never calls Gemma
              └─ YES → this.provider.complete(request)     ← delegate to Gemma
                              │
                              ▼  GemmaModelProvider → Ollama
```

Why it matters more here: an oversized prompt to a frontier model is a worse answer
and a bigger bill; an oversized prompt to a 9b local model with a tight window is a
*truncated, broken* answer. The guard turns "silently degraded" into a clean,
catchable error — which a fallback chain can then route around.

#### Step 3 — compose it under the fallback chain (local-first, cloud-backstop)

Because both arms are `ModelProvider`s, a `FallbackModelProvider` can hold them in
order: try guarded-Gemma first, and only on a thrown error (Gemma down, or the
guard rejecting an overflow) fall through to a cloud provider.

```
  Local-first fallback — composition, not branching

  FallbackModelProvider [ guardedGemma, anthropic ]
        │ try providers[0]
        ▼
   guardedGemma.complete()
        ├─ ok    → return (zero-cloud, private, free)
        └─ throw → record attempt, try providers[1]
                          ▼
                    anthropic.complete()   ← cloud backstop, only on failure
```

The boundary condition: `FallbackModelProvider` re-throws on abort but falls
through on any other error, so a `ContextWindowExceededError` from the guard is a
*fallback trigger*, not a crash. You get local economics in the common case and
cloud capability only when you have to pay for it.

### Move 3 — the principle

Default to local, escalate to cloud on need. The narrow port is what makes the
escalation a composition instead of a rewrite — the same `implements ModelProvider`
that lets a fixture stand in for a vendor lets a local 9b model stand in for a
frontier one, and lets a guard and a fallback chain wrap either. Pick the arm per
the five-axis table: if the data is sensitive, the budget is per-call-hostile, or
you need offline, the local arm earns its place — and you pay for it in capability,
which you buy back with emulation, a context guard, and tool-side floors.

## Primary diagram

The full picture — both arms, the local-only guard, and the fallback that composes
them.

```
  Local vs cloud — the complete map

  ┌─ Core (runtime, agents) — VENDOR-FREE ──────────────────────────┐
  │  RagQueryAgent runs ZERO-CLOUD: Gemma + nomic, both via Ollama   │
  │  import { ModelProvider } only                                   │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │ complete(request)
  ┌─ Port: ModelProvider ─────────▼──────────────────────────────────┐
  │  { id, defaultModel?, complete() }                               │
  └──┬────────────────────────────────────────────────┬──────────────┘
     │                                                 │
  ┌──▼─ FallbackModelProvider (decorator) ─────────────▼───────────┐
  │  [ guardedGemma , anthropic ]   try in order, fall through     │
  └──┬──────────────────────────────────────────┬──────────────────┘
     │ providers[0]                              │ providers[1]
  ┌──▼─ ContextWindowGuardedProvider ──┐   ┌─────▼─────────────────┐
  │  estimate tokens; throw if over    │   │ AnthropicModelProvider │
  │  (small window — can't buy bigger) │   │ claude-sonnet · HTTPS  │
  └──┬─────────────────────────────────┘   │ per-token · data off-box│
  ┌──▼─ GemmaModelProvider ────────────┐   └────────────────────────┘
  │  id=gemma · gemma2:9b              │
  │  POST localhost:11434/api/chat     │  ← LOCAL: free, private, offline,
  │  weaker at tools/JSON → emulates   │     but weaker (see file 07)
  └────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The `RagQueryAgent` is the flagship local case: it pairs
`GemmaModelProvider` with a local `nomic`-embedding retrieval pipeline, so the whole
question-answering loop runs *zero-cloud* — private by construction, free per query,
works offline. Production cloud runs construct an `AnthropicModelProvider`
(`claude-sonnet`) or `OpenAIModelProvider` (`gpt-4.1`) instead. The agent code is
identical across all three; only the injected provider differs — that's the port
paying off (`08-provider-abstraction.md`).

**The local adapter — id, default model, transport**,
`packages/providers/gemma/src/gemma-provider.ts:39-50`:

```
  packages/providers/gemma/src/gemma-provider.ts  (lines 39-50)

  export class GemmaModelProvider implements ModelProvider {
    readonly id = 'gemma';                                  ← rides on every usage event
    readonly defaultModel: string;
    constructor(options: GemmaModelProviderOptions = {}) {
      this.defaultModel = options.model ?? 'gemma2:9b';     ← the open-weights model
      this.chat = options.chat
        ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');  ← Ollama, on-box
      this.maxToolCallAttempts = Math.max(1, options.maxToolCallAttempts ?? 2);
    }
       │
       └─ Same three members as the Anthropic adapter (id/defaultModel/complete).
          The ONLY difference visible here: the host is localhost, not a vendor API.
          chat is injectable, so tests run without a GPU.
```

**The Ollama transport — the network boundary that isn't crossed**,
`packages/providers/gemma/src/gemma-provider.ts:201-215`:

```
  packages/providers/gemma/src/gemma-provider.ts  (lines 201-214)

  function defaultHttpTransport(host: string): GemmaChatTransport {
    const base = host.replace(/\/$/, '');
    return async ({ signal, ...payload }) => {
      const res = await fetch(`${base}/api/chat`, {                  ← localhost:11434
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
      return (await res.json()) as OllamaChatResponse;
    };
  }
       │
       └─ The "network" hop is a loopback to a process on the same machine.
          No prompt leaves the box; no per-token bill. That's privacy + cost,
          structurally — not a policy you have to remember to enforce.
```

**The local-only guard — a smaller window you can't buy out of**,
`packages/providers/local/src/context-window-guard.ts:57-70`:

```
  packages/providers/local/src/context-window-guard.ts  (lines 57-70)

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const estimate = estimateContextWindow(request, this.options);  ← estimate FIRST
    if (!estimate.ok) {
      this.options.trace?.emit({ type: 'warning', /* ...skipping local... */ });
      throw new ContextWindowExceededError(estimate);                ← refuse BEFORE delegating
    }
    return this.provider.complete(request);                          ← only now call Gemma
  }
       │
       └─ Decorator over the port (08): wraps ANY provider. It matters MORE on the
          local arm because a 9b model's window is small and there's no bigger SKU
          to rent — overflow is a broken answer, so turn it into a clean throw.
```

**The cloud contrast**: `packages/providers/anthropic/src/anthropic-provider.ts:18`
and `packages/providers/openai/src/openai-provider.ts:23` are the cloud arm — same
port, but their transport is an authenticated HTTPS call to a vendor SDK that bills
per token and returns *native* `tool_use` / `tool_calls` blocks. Gemma has no native
tools API, which is the capability gap this whole file is about.

## Elaborate

The open-weights movement (Gemma, Llama, Mistral) made local inference a real
option for production, not just a hobby — a 9b model on a consumer GPU answers
ordinary questions well. The catch is that "answers questions" and "drives an agent
loop" are different bars. Frontier models cleared the tool-calling bar with native
APIs; a 9b open-weights model has to be *coaxed* into structured tool calls, and it
fails more often. So the local arm isn't a drop-in for the cloud arm — it's a
cheaper, more private arm that needs scaffolding the cloud arm doesn't:
prompt-rendered tools, a parse-retry loop, and tool-side floors against weak
arguments.

Two AptKit choices are worth defending. First, Gemma sits behind the *same narrow
port* as the cloud adapters — so "go local" is a one-line provider swap, and the
guard and fallback chain compose over it for free. Second, the guard wraps the
local arm specifically: the cloud arm tolerates a fat prompt (worse answer, bigger
bill), but the local arm can't, so the guard converts overflow into a catchable
error the fallback chain routes around. The result is a system that defaults to
private-and-free and escalates to smart-and-paid only on demand.

Adjacent: the port itself (`08-provider-abstraction.md`); the token estimate the
guard uses (`02-tokenization.md`); the emulation that buys back the capability gap
(`../04-agents-and-tool-use/07-emulated-tool-calling.md`); the fallback chain that
composes the two arms (`../06-production-serving/05-retry-circuit-breaker.md`); the
parse-retry as error recovery (`../04-agents-and-tool-use/06-error-recovery.md`).

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case A — the local arm exists; these extend it.*

### Exercise — compose Gemma local-first under the fallback chain

- **Exercise ID:** `[C1.10]` Phase 1, local-vs-cloud
- **What to build:** Wire a `FallbackModelProvider` whose first provider is a
  `ContextWindowGuardedProvider` over `GemmaModelProvider`, and whose second is an
  `AnthropicModelProvider`. Run the `RagQueryAgent` against it. Prove that a normal
  question is answered by Gemma (zero-cloud), and that a deliberately oversized
  prompt — one that trips `ContextWindowExceededError` — falls through to the cloud
  provider instead of crashing.
- **Why it earns its place:** It exercises the entire thesis of this file: same
  port, two arms, composed not branched. You feel the guard-throw becoming a
  fallback trigger, which is the load-bearing interaction between the local arm and
  the chain.
- **Files to touch:** a new test or script under
  `packages/agents/rag-query/`; construct providers from
  `packages/providers/gemma`, `packages/providers/local`,
  `packages/providers/fallback`, `packages/providers/anthropic`.
- **Done when:** one test shows Gemma answering a small question and another shows
  the chain selecting the cloud provider after the guard rejects an oversized
  prompt (`FallbackModelProvider.lastSelectedProvider` confirms which arm answered).
- **Estimated effort:** `1–4hr`

### Exercise — A/B the rag-query answer quality, Gemma vs cloud

- **Exercise ID:** `[C1.11]` Phase 1, capability axis
- **What to build:** Run the `RagQueryAgent`'s eval over the same questions twice —
  once with `GemmaModelProvider`, once with `AnthropicModelProvider` — and record
  where Gemma misses (especially multi-part questions and tool-call discipline).
- **Why it earns its place:** It makes the capability axis concrete instead of
  asserted. You see *which* questions a 9b model fumbles, which is exactly the
  evidence you'd bring to a "do we need cloud here?" decision.
- **Files to touch:** `packages/agents/rag-query/scripts/eval.ts` (parameterize the
  provider), read-only against the index.
- **Done when:** you have a side-by-side pass/fail table and at least one concrete
  failure class attributable to the weaker model.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: When would you run a local open-weights model instead of a hosted frontier
model?**
"When the tradeoff table favors it. I'd draw the five axes:"

```
  axis        local (Gemma2:9b)        cloud (sonnet/gpt-4.1)
  cost     →  zero per-call            per-token
  privacy  →  on-box, never leaves     prompt on their wire
  offline  →  works                    needs network
  latency  →  no net, slow 9b          net + fast big model
  capability→ weaker (tools/JSON)      frontier-smart
```

"Local wins cost, privacy, and offline; cloud wins capability. So for a private,
budget-sensitive, possibly-offline workload — like a personal knowledge assistant
over my own notes — I run Gemma2:9b on Ollama. AptKit's `RagQueryAgent` does exactly
that: Gemma plus a local nomic embedder, zero-cloud. The price is capability, which
I buy back with emulated tool-calling and a context guard. And because Gemma is the
same `ModelProvider` port as the cloud adapters, going local is a constructor swap —
`gemma-provider.ts:39`."
*Anchor: pick the arm by the table; the narrow port makes the pick a one-liner.*

**Q: Why does the context-window guard matter more for a local model?**
"Because you can't buy your way out of a small window on-box. A frontier model with
a fat prompt gives a worse answer and a bigger bill — annoying, not broken. A 9b
local model with a tight window gives a *truncated, broken* answer, and there's no
bigger SKU to rent. So I wrap Gemma in `ContextWindowGuardedProvider`, which
estimates input tokens and throws `ContextWindowExceededError` *before* it ever
calls the model — `context-window-guard.ts:60`. That clean throw is then a fallback
trigger: the chain routes the overflowing request to a cloud provider with a bigger
window instead of crashing."
*Anchor: overflow on local is a broken answer, so convert it to a catchable error.*

## Validate

- **Reconstruct:** From memory, draw the five-axis local-vs-cloud table and mark
  which arm wins each axis. Check against the capability gap that drives emulation
  in `gemma-provider.ts:52-92`.
- **Explain:** Why is going from cloud to local a one-line change in AptKit? (Both
  arms `implements ModelProvider`; the core imports only the port. You construct a
  `GemmaModelProvider` instead of an `AnthropicModelProvider` —
  `gemma-provider.ts:39` — and inject it. `08-provider-abstraction.md`.)
- **Apply:** A request's prompt is too big for Gemma's window in a local-first
  fallback chain. What happens? (The guard estimates over budget and throws
  `ContextWindowExceededError` before delegating — `context-window-guard.ts:60-67`;
  `FallbackModelProvider` catches it and falls through to the cloud provider —
  `fallback-provider.ts:64-86`.)
- **Defend:** Why does the `RagQueryAgent` run zero-cloud rather than just using a
  cheap cloud model? (Privacy and offline, not only cost — the user's notes never
  leave the box, and it works with no network. Gemma + local nomic embeddings make
  the whole loop on-device — `rag-query-agent.ts:62-83`.)

## See also

- [08-provider-abstraction.md](08-provider-abstraction.md) — the port both arms implement
- [02-tokenization.md](02-tokenization.md) — the token estimate the local guard uses
- [../04-agents-and-tool-use/07-emulated-tool-calling.md](../04-agents-and-tool-use/07-emulated-tool-calling.md) — how Gemma buys back the tool-calling gap
- [../04-agents-and-tool-use/06-error-recovery.md](../04-agents-and-tool-use/06-error-recovery.md) — the parse-retry that recovers a weak model's bad output
- [../06-production-serving/05-retry-circuit-breaker.md](../06-production-serving/05-retry-circuit-breaker.md) — the fallback chain that composes local-first
