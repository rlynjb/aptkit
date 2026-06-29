# Chapter 3 — The Choices

This is the chapter that decides the interview. Every senior loop has a
stretch where someone picks one technology decision and asks "why this and
not that." If you can defend your load-bearing choices on real criteria —
naming the alternative, the decision axis, and the cost you're paying — you
read as someone who *designed* the system. If you can't, every clever thing
you built reads as luck.

I'm going to defend the choices that actually carry weight. Not the test
runner, not the CSS approach — nobody senior cares which CSS tool you used.
The load-bearing choices in aptkit are: **the local Gemma default**, **RAG
from scratch instead of a framework**, **in-memory vector store first**, and
**one published bundle instead of N packages**. Four decisions. We defend all
four.

## The chapter-opening diagram — the decision tree, picked paths lit

Here's the map of the major choices with the path you took highlighted. Each
fork is a real decision with a real alternative and a real cost.

```
THE LOAD-BEARING CHOICES — forks taken, costs paid

  MODEL PROVIDER?
    ├── frontier only (Claude/GPT)
    └──►★ LOCAL GEMMA default + cloud unbundled        ★ PICKED
         cost: emulated tool-calling, weaker model

  RETRIEVAL?
    ├── framework (LangChain / LlamaIndex)
    └──►★ RAG FROM SCRATCH behind 2 contracts          ★ PICKED
         cost: I own the chunker, ranking, the bugs

  VECTOR STORE, DAY ONE?
    ├── pgvector immediately
    └──►★ IN-MEMORY first, contract makes swap 1 line   ★ PICKED
         cost: no persistence in aptkit itself (by design)

  PACKAGING?
    ├── publish 16 packages separately
    └──►★ ONE BUNDLE (@rlynjb/aptkit-core)             ★ PICKED
         cost: consumers can't pick à la carte; "files" gotcha

  axis that decides all four: "what does the LIBRARY owe its
  consumer, and what should the consumer be free to choose?"
```

The single axis under all four choices is the same: *what does the library
own, and what does it leave open?* That's the through-line. Now each fork.

### Choice 1 — Local Gemma as the default provider

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Why default to a local Gemma instead of just     │
│    using Claude or GPT?"                            │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Did you pick local for a reason, or because it's  │
│   free? Do you understand what you GIVE UP with a   │
│   weak local model — and did you build for it?      │
└─────────────────────────────────────────────────────┘
```

> "Two reasons, and they're deliberate. First, the default has to run with no
> cloud key — `git clone`, `npm install`, and it works against Ollama on
> localhost:11434 with no secret and no billing surface. That's a real
> property for a library people clone to learn from. Second, defaulting to a
> *weak* local model was a forcing function: if my agent loop and retrieval
> survive Gemma, they survive anything. Gemma has no native tool-calling at
> all, so I had to emulate it — prompt it to emit a JSON tool call, parse it
> with `parseAgentJson`, retry on a parse failure. That's in
> `packages/providers/gemma/gemma-provider.ts`.
>
> The cost I'm paying is real: Gemma is less reliable than Claude, the
> emulated tool-calling is fragile, and latency is whatever your laptop does.
> So Anthropic and OpenAI are first-class providers behind the same
> `complete()` contract — they're just *unbundled*, opt-in via env key.
> Swapping to Claude is a provider swap, not a rewrite, because everything
> talks to `complete()`, never a vendor SDK."

That answer names the criterion (no-key default + forcing function), names
the cost (reliability, fragile emulation, latency), and names the escape
hatch (one-contract swap to frontier). That's a complete defense.

```
┃ Defaulting to a weak local model was a forcing function:
┃ if the loop survives Gemma, it survives anything.
```

```
"Why local Gemma?"
      │
      ├─► IF THEY ASK "isn't Gemma too weak to be useful?"
      │     Yes, for hard reasoning. That's WHY it's the
      │     default — it stress-tests the loop. Production
      │     swaps to Claude in one line. Cost owned, not hidden.
      │
      ├─► IF THEY ASK "how does emulated tool-calling work?"
      │     Outbound: prompt describes the tool, asks for JSON.
      │     Inbound: parseToolCall reads the JSON back, retries
      │     on malformed output. → deep dive in Ch06.
      │
      └─► IF THEY ASK "what about latency / cost at scale?"
            Local has no per-token cost but laptop latency.
            Frontier flips it: pay per token, get speed +
            reliability. At real scale I'd flip to frontier —
            → that's a counterfactual in Ch07.
```

### Choice 2 — RAG from scratch, not a framework

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Why build RAG from scratch instead of using      │
│    LangChain or LlamaIndex?"                        │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Did you reinvent a wheel out of NIH syndrome, or  │
│   was there a real reason? Do you actually          │
│   understand what's INSIDE a RAG pipeline, or did   │
│   a framework hide it from you?                     │
└─────────────────────────────────────────────────────┘
```

> "The whole point of aptkit was to understand the substrate, not to ship a
> product fast. A framework would have hidden exactly the parts I wanted to
> own — the chunker, the embedding step, the ranking, the tool boundary. So I
> built the pipeline as two contracts: `EmbeddingProvider` and `VectorStore`,
> in `packages/retrieval/contracts.ts`. The pipeline logic — embed, upsert,
> search, rank — never names a vendor. nomic, OpenAI, pgvector, in-memory are
> all incidental.
>
> What I got from building it myself is that I can point at every line. The
> retrieval reaches the agent as a *tool*, `search_knowledge_base`, not as
> bespoke control flow inside the agent. That tool has a `minTopK` floor and
> a hallucination-tolerant filter — both of which exist because I hit real
> bugs a framework would have hidden from me. I'll tell you about the filter
> bug in a minute; it's my favorite thing I fixed.
>
> The cost: I own the chunker, the ranking, and every bug. A framework would
> have given me retries and connectors for free. For a learning system that's
> the right trade. For a deadline-driven product, I'd probably reach for a
> framework — and that's an honest counterfactual."

The pgvector colocation point connects to your AdvntrCue experience — you
already shipped vector + relational data in one Postgres instance. Use it:
"I'd shipped classic RAG before, in AdvntrCue with Next.js and pgvector and
GPT-4. aptkit was me going one level down — building the pipeline I'd
previously gotten from the platform."

```
┃ A framework hides exactly the parts I wanted to own:
┃ the chunker, the ranking, the tool boundary.
```

### Choice 3 — In-memory vector store first

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Why an in-memory vector store? Isn't that a toy? │
│    Why not pgvector from day one?"                  │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Is in-memory a shortcut you'll have to rip out    │
│   later (tech debt), or a deliberate sequencing     │
│   decision? Do you know the difference?             │
└─────────────────────────────────────────────────────┘
```

This is the one where the weak answer is "I'll upgrade it later" and the
strong answer is "it's not debt, it's sequencing." Here's the side-by-side
because the failure mode is so common:

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "In-memory was just to get   │ "In-memory was deliberate     │
│  it working — I'd swap it     │  sequencing. The VectorStore  │
│  for a real database later    │  CONTRACT is the product; the │
│  when I needed persistence."  │  in-memory cosine scan is the │
│                              │  reference implementation     │
│                              │  that proves the contract is  │
│                              │  enough. buffr's PgVectorStore │
│                              │  implements the SAME contract  │
│                              │  over pgvector — and the swap  │
│                              │  is one line because the       │
│                              │  boundary was right from day   │
│                              │  one. It's not debt I'll repay;│
│                              │  it's sequencing I'd repeat."  │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ "swap it later" frames it as │ Reframes in-memory as the     │
│ a shortcut — debt you took   │ thing that PROVES the contract│
│ on. Invites "so when's the   │ holds. The one-line buffr swap│
│ later?" and you have no       │ is the evidence. There's no   │
│ answer.                      │ "later" because there's no debt.│
└──────────────────────────────┴──────────────────────────────┘
```

> "In-memory wasn't a shortcut, it was sequencing. The `VectorStore` contract
> is the actual product — a corpus embedded at one dimension can't be
> searched by a query of another, so the store carries its own `dimension`
> and rejects a mismatched vector loudly. `InMemoryVectorStore` is the
> reference implementation: a brute-force cosine scan over an array. It exists
> to prove the contract is *enough*. And the proof is buffr: `PgVectorStore`
> implements that same `VectorStore` interface over Supabase pgvector with an
> HNSW index, and swapping aptkit's in-memory store for it is one line. If the
> boundary had been wrong, that swap would have been a rewrite. So in-memory
> isn't debt I'm going to repay — it's a decision I'd make again."

When would you flip this? Almost never. That's the honest answer and it's a
strong one — "I'd reconsider in-memory roughly never, because it's sequencing,
not debt. The only thing I'd change is shipping a third store implementation
sooner to prove the contract against a *second* real backend, not just one."

```
        ▸ In-memory first isn't tech debt. It's the reference
          implementation that proves the contract is enough.
```

### Choice 4 — One bundle, not sixteen packages

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "You have 16 internal packages but publish ONE    │
│    bundle. Why not publish them separately so       │
│    consumers can pick what they need?"              │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand the operational cost of         │
│   publishing N versioned packages vs one? Did you   │
│   weigh consumer ergonomics against maintenance?    │
└─────────────────────────────────────────────────────┘
```

> "Sixteen separately-versioned packages means sixteen version-compatibility
> matrices and a consumer who has to assemble the right set. For one consumer
> — buffr — that's all cost and no benefit. So the root is `private: true`,
> the internal packages stay at `0.0.0`, and I publish exactly one thing:
> `@rlynjb/aptkit-core`, currently `0.4.1`, which inlines all 16 via
> `bundledDependencies`. `scripts/pack-core-standalone.mjs` builds the
> standalone tarball, and the public surface is `packages/core/src/index.ts`.
> buffr installs one dependency and gets the whole composed library.
>
> The cost I'm paying: consumers can't pick à la carte, and there's a sharp
> packaging gotcha I documented in `RELEASE.md` — every bundled package needs
> an explicit `"files": ["dist/src"]`, because without it `npm pack` excludes
> the gitignored `dist` and you ship an empty package. I hit that and wrote it
> down so the next person doesn't.
>
> When would I split? When there's a *second* consumer with different needs.
> One consumer, one bundle. Multiple consumers wanting different subsets, you
> split. It's a consumer-count decision, not a dogma."

That `RELEASE.md` gotcha is gold in an interview — it's proof you actually
shipped this to a registry and hit the real edges, not just `npm link`'d it
locally. Reach for it.

```
╔════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                     ║
║                                                         ║
║   They push on packaging internals: "How does           ║
║   bundledDependencies interact with peer deps and       ║
║   transitive version resolution? What if buffr already  ║
║   has a different version of one of your bundled deps?" ║
║                                                         ║
║   You set up bundledDependencies and hit the "files"    ║
║   gotcha — but you have NOT stress-tested transitive    ║
║   dependency conflict resolution across consumers.      ║
║                                                         ║
║   Say:                                                  ║
║   "My internal packages are all @aptkit/* at 0.0.0 and  ║
║    only consumed inside the bundle, so I haven't hit a  ║
║    transitive version conflict — buffr depends on the   ║
║    bundle as a single unit, not on the inner packages.  ║
║    The detailed resolution behavior when a consumer has ║
║    a conflicting transitive dep is something I'd have to ║
║    test rather than tell you from memory. What I DID    ║
║    hit and document is the 'files' allowlist gotcha —   ║
║    want that one?"                                      ║
║                                                         ║
║   What this signals: you know the boundary of your own  ║
║   experience, you don't bluff npm internals, and you    ║
║   redirect to a real scar (the files gotcha) you can    ║
║   defend completely.                                    ║
║                                                         ║
║   Do NOT say:                                           ║
║   "npm just dedupes it, it figures out the right        ║
║    version..." — you're guessing at resolution behavior ║
║   and a packaging-literate interviewer will know it.    ║
╚════════════════════════════════════════════════════════╝
```

## What you'd change

The one choice I'd most want to revisit is the local-Gemma default — not
because it was wrong for a *learning* system, but because if aptkit had a real
user base, defaulting to the least reliable provider would be backwards. I'd
keep Gemma as the zero-key *demo* path and make a frontier provider the
default for anyone past the tutorial. The forcing-function value was real
during the build; it's the wrong default for production. That's a clean
counterfactual — the decision was right for its phase and wrong for the next
one, and naming that distinction is the senior move. (Full treatment in
Chapter 7.)

## One-page summary — Chapter 3

```
CORE CLAIM
  Four load-bearing choices, one axis: what does the LIBRARY
  own vs leave open? Name the alternative, the criterion, the cost.

CHOICES DEFENDED
  1. Local Gemma default — zero-key + forcing function;
     cost: weak model, emulated tool-calling. Frontier = 1-line swap.
  2. RAG from scratch — own the chunker/ranking/tool boundary;
     cost: own every bug. Framework = right call for a deadline.
  3. In-memory store first — NOT debt, it's sequencing; the
     reference impl that proves the contract. buffr swap = 1 line.
  4. One bundle not 16 packages — one consumer, one bundle;
     cost: no à la carte; the RELEASE.md "files" gotcha.

PULL QUOTES
  ▸ A weak local default was a forcing function.
  ▸ A framework hides the parts I wanted to own.
  ▸ In-memory first isn't debt; it's the reference implementation.

WHAT YOU'D CHANGE
  Make frontier the default past the tutorial; keep Gemma as the
  zero-key demo path. Right default for the build, wrong for prod.
```
