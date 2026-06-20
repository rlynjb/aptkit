# Chapter 3 — The choices

## Opening hook

In every senior interview there's a moment — usually right after you've walked the architecture — where the interviewer stops nodding and starts poking. "Why Gemma? Why not just call Claude?" "Why did you build your own RAG instead of using LangChain?" "Why one published package and not several?" This is the chapter that gets you through that ten minutes without flinching.

Here's the thing you need to internalize before we start: an interviewer is not grading your stack. They're grading whether you can *defend* it — whether you knew there were alternatives, knew what each one cost, and made a call you can still stand behind. A defaulted choice you can't explain reads as junior even when the choice was correct. A consciously-paid cost reads as senior even when the choice was unusual. AptKit is full of unusual choices. That's a gift in an interview, because every one of them has a reason, and the reasons are *yours*. Let's arm each one.

## The chapter-opening diagram

Here is the decision tree of every load-bearing choice in aptkit, with the option you picked highlighted and the cost you're paying named on the branch you didn't take.

```
  THE CHOICES — what you picked, what it cost

  ┌─ MODEL ────────────────────────────────────────────────────────┐
  │  cloud-only (Anthropic/OpenAI)   ◄── still available as fallback│
  │  ★ LOCAL Gemma via Ollama (default) ★                          │
  │     cost paid: Gemma has NO native tool-calling → emulate it    │
  │                + weaker model → guard rails (minTopK, filter)   │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ how does the model reach data?
  ┌─ RAG ─────────────────────────▼────────────────────────────────┐
  │  framework (LangChain / LlamaIndex)                             │
  │  ★ CONTRACTS (EmbeddingProvider + VectorStore) ★               │
  │     cost paid: more code I own vs glue I import                 │
  │     bought:    clean tests, no lock-in, "pattern over vendor"   │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ how does code touch the model?
  ┌─ PROVIDER SEAM ───────────────▼────────────────────────────────┐
  │  code to a vendor SDK directly                                  │
  │  ★ ModelProvider.complete() contract ★                         │
  │     the ONE seam that buys swap + fixture + fallback at once    │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ where does the vector store live?
  ┌─ DEPLOYMENT SPLIT ────────────▼────────────────────────────────┐
  │  pgvector everywhere                                            │
  │  ★ InMemoryVectorStore in aptkit · PgVectorStore in buffr ★    │
  │     same VectorStore contract, two implementations             │
  │     cost paid: in-memory store isn't durable (by design)        │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ how do consumers install it?
  ┌─ PUBLISHING ──────────────────▼────────────────────────────────┐
  │  N separately-published packages   ·   git dependencies         │
  │  ★ ONE bundle: @rlynjb/aptkit-core (bundledDependencies) ★     │
  │     15 internal packages → one standalone tarball, one version  │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ what proves it works?
  ┌─ TESTING ─────────────────────▼────────────────────────────────┐
  │  jest / vitest                                                  │
  │  ★ node:test + injectable transports (TDD) ★                   │
  │     zero deps; the fixture seam IS the test strategy            │
  └─────────────────────────────────────────────────────────────────┘
```

Six choices, top to bottom, each one feeding the next. Notice the shape: every branch you took costs you something concrete, and every cost buys you something you can name — that's the entire content of this chapter, and it's the entire content of a good "why this stack" answer.

---

## Choice 1 — Local Gemma/Ollama as the default model

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Why a local model? Why not just default to       │
│    Claude or GPT-4 like everyone else?"             │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Did you pick local for a reason, or because it    │
│   was free? Do you understand what you GIVE UP with │
│   open-weights — the missing capabilities — and did │
│   you engineer around them? Can you name the cost   │
│   instead of pretending local is strictly better?   │
└─────────────────────────────────────────────────────┘
```

The strong answer leads with *why*, then immediately volunteers the cost — because the cost is the interesting engineering.

> I made local Gemma over Ollama the default provider for three reasons: cost, privacy, and learning. Cost — the default path makes zero cloud calls, so I can run the whole agent loop on my laptop with no API bill. Privacy — nothing leaves the machine, which matters for the deployment target, buffr, which is a laptop runtime. And learning — open-weights forced me to understand the parts a cloud SDK hides. But the real story is the cost I'm paying, which is the part I'd actually want to talk about. Gemma has *no native tool-calling*. Anthropic and OpenAI give you a `tools` array and a structured `tool_use` block back. Gemma gives you neither. So in `GemmaModelProvider` I emulate it: I render the tool schemas into the system prompt as JSON, demand the model reply with `{"tool": "...", "arguments": {...}}` and nothing else, then parse that back into the same `tool_use` block shape the rest of the system expects. And because Gemma is a weaker model, it botches that JSON sometimes — so there's a retry with a corrective nudge, and a parse step that's deliberately lenient. Cloud stays available behind the same contract, so when I want the stronger model I swap the provider and pay the bill.

Now the contrast — the weak version of this answer is the one that pretends local has no downside.

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "I used a local model       │ "I defaulted to local Gemma │
│ because it's free and       │ for cost, privacy, and      │
│ private and you don't       │ learning — but the real     │
│ need an API key. It's       │ engineering is the cost:    │
│ better for privacy."        │ Gemma has no native tool-   │
│                             │ calling, so I emulate it in │
│                             │ GemmaModelProvider — render │
│                             │ tools into the prompt, parse│
│                             │ a JSON tool call back out,  │
│                             │ retry when the weaker model │
│                             │ botches the JSON. Cloud      │
│                             │ stays behind the same        │
│                             │ contract as a fallback."     │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ Lists benefits, names no    │ Names the benefit AND the   │
│ cost. "Better for privacy"  │ capability you gave up, then│
│ is a slogan. An interviewer │ shows the concrete code that│
│ hears someone who picked    │ pays for it. The retry and  │
│ the easy thing and never    │ lenient parse prove you hit │
│ hit a wall — which means    │ the wall and engineered     │
│ they don't believe you      │ through it. That's the whole│
│ built anything hard.        │ signal.                     │
└─────────────────────────────┴─────────────────────────────┘
```

The load-bearing detail here — the one that proves you built it — is the emulation. In `packages/providers/gemma/src/gemma-provider.ts`, the outbound half renders each tool as JSON into the system text with the instruction *"When a tool is needed, respond with ONLY a single JSON object, no prose."* The inbound half (`parseToolCall`) runs the raw text through `parseAgentJson` and maps `obj.tool ?? obj.name ?? obj.tool_name` into the canonical `ModelToolUseBlock`. The `maxToolCallAttempts` (default 2) plus the `RETRY_NUDGE` constant are the guard against Gemma's weakness — and crucially, the retry only fires when the reply *looked* like a botched tool call (a stray `{` is the cheap tell); plain prose is treated as a real answer, not a failure. That distinction is the kind of thing interviewers love, because it shows you thought about the boundary condition.

The second guard rail lives downstream, in the retrieval tool — and it exists *because* the model is weak. In `packages/retrieval/src/search-knowledge-base-tool.ts`, `minTopK` floors the number of chunks fetched (`const topK = Math.max(requestedTopK, minTopK)`) so a weaker model can't accidentally starve itself of context by asking for too few. And `matchesFilter` is written so a hallucinated filter key can't silently wipe every result: *"A filter key only excludes hits that HAVE that key with a different value."* If Gemma invents `{textContains: "x"}`, chunks that simply don't have that key survive. That's robustness engineered against a known model failure mode — name it and you sound like someone who's run this against a real weak model, because you have.

```
┃ "The interesting part of choosing a weak model isn't
┃  the model — it's the guard rails the weakness forces
┃  you to build."
```

Here's the follow-up tree for this choice. The branches are where this conversation actually goes.

```
  "Why local Gemma instead of cloud?"
        │
        ▼
  You give the cost/privacy/learning answer
  and volunteer the no-tool-calling cost.
        │
        ├─► IF THEY ASK "how do you emulate tool-calling?"
        │     Walk gemma-provider.ts: render tools into
        │     system prompt as JSON, demand a single JSON
        │     object back, parse it into a tool_use block,
        │     retry with a nudge when Gemma botches it.
        │
        ├─► IF THEY ASK "isn't that fragile?"
        │     Yes — that's why minTopK floors context and
        │     matchesFilter can't wipe results on a bad
        │     key. The fragility is contained, not ignored.
        │
        └─► IF THEY ASK "what about when you need a real model?"
              The provider contract makes that a one-line
              swap — FallbackModelProvider can put Gemma
              first and Claude behind it. Same call site.
```

---

## Choice 2 — RAG built from contracts, not a framework

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Why did you build your own RAG pipeline instead  │
│    of using LangChain or LlamaIndex?"               │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand RAG well enough to build it, or │
│   did you only learn the framework's API? Did you   │
│   weigh "more code I own" against "a framework I'm   │
│   locked into"? Can you justify the extra code with  │
│   something concrete, not just "I wanted control"?  │
└─────────────────────────────────────────────────────┘
```

This is the choice where your background does the heaviest lifting. You've shipped cloud RAG before — AdvntrCue, Next.js + pgvector + GPT-4. So when you say "I built it from scratch this time," it doesn't sound like you avoided the framework out of inexperience. It sounds like you'd done it the production way already and chose to extract the reusable shape.

> I built the RAG pipeline from two contracts instead of pulling in LangChain. The whole pipeline depends on `EmbeddingProvider` and `VectorStore` — both defined in `packages/retrieval/src/contracts.ts` — and the pipeline logic never names a vendor. That's deliberate. I'd already shipped cloud RAG in a previous project, AdvntrCue, on GPT-4 and pgvector. The pattern I learned there is that vector stores rotate — Pinecone, pgvector, Weaviate, Qdrant — but the *shape* never changes: embed, approximate-nearest-neighbor search, retrieve. So this time I built that invariant as a contract I own. The cost is real: it's more code than `import` from a framework. What it buys me is clean testability — I can drop in an `InMemoryVectorStore` and test the whole pipeline with no Postgres — and no framework lock-in. When the framework breaks on a version bump or hides the chunking logic I need to tune, that's not my problem, because there's no framework.

The "pattern over vendor" line is yours — it's in `me.md` as an explicit value — and it lands hard here because the code *is* the value made literal. Read the header comment in `contracts.ts`: *"the pipeline logic never names a vendor (nomic / OpenAI / pgvector / in-memory are incidental)."* That's not a coincidence you can defend; that's a principle you wrote into the file.

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "I built my own RAG         │ "I built RAG from two        │
│ because frameworks are      │ contracts — EmbeddingProvider│
│ bloated and I wanted        │ and VectorStore. The pipeline│
│ full control over the       │ never names a vendor; embed +│
│ pipeline."                  │ ANN + retrieve is the        │
│                             │ invariant, the vendor is     │
│                             │ incidental. I'd shipped cloud│
│                             │ RAG before on pgvector, so I │
│                             │ knew the shape and extracted │
│                             │ it reusable. Cost: more code.│
│                             │ Buys: in-memory tests, no    │
│                             │ lock-in."                    │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ "Frameworks are bloated"    │ Names the contracts, the    │
│ is a vibe, not a reason.    │ pattern, the prior shipped   │
│ "Full control" with no      │ project, the exact cost, and │
│ named payoff sounds like    │ the exact payoff. The        │
│ NIH syndrome. An            │ interviewer can't accuse you │
│ interviewer suspects you    │ of not knowing the framework │
│ couldn't drive the          │ — you knew it well enough to │
│ framework.                  │ choose against it on purpose.│
└─────────────────────────────┴─────────────────────────────┘
```

```
        ▸ Frameworks rotate; the pattern doesn't.
          I built the pattern as a contract and let
          the vendor be a swappable detail.
```

The follow-up tree — and note where the dangerous branch is.

```
  "Why not LangChain?"
        │
        ▼
  You give the contracts + pattern-over-vendor answer.
        │
        ├─► IF THEY ASK "what does the framework give you
        │   that you gave up?"
        │     Honesty: connectors, chunking strategies,
        │     and integrations out of the box. I re-wrote
        │     the chunking and index/query paths myself.
        │     For a reusable library, owning them was
        │     worth it; for a one-off app, maybe not.
        │
        ├─► IF THEY ASK "how do you test it?"
        │     InMemoryVectorStore — cosine over an array.
        │     The whole index→query path runs with no
        │     external service. That's the payoff of the
        │     contract made concrete.
        │
        └─► IF THEY PUSH "isn't this just reinventing
            the wheel?"  ◄── the trap
              Don't get defensive. "For an app, yes —
              I'd use the framework. This is a library
              meant to be consumed by other apps, so the
              reusable contract IS the product."
```

---

## Choice 3 — The provider-neutral `ModelProvider` contract

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Why route everything through a ModelProvider      │
│    interface instead of calling the SDK directly?"  │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand what an abstraction buys, and    │
│   what it costs? Can you name the ONE seam that      │
│   makes the rest of the system possible — or do you  │
│   add interfaces reflexively because "abstraction    │
│   is good"?                                         │
└─────────────────────────────────────────────────────┘
```

This is the most important choice in the whole repo, and the strong answer says so out loud. Everything else in this chapter hangs off this one seam.

> Everything in the system depends on one method: `ModelProvider.complete(request)`, defined in `packages/runtime/src/model-provider.ts`. Nothing in the agent loop ever touches `@anthropic-ai/sdk` or `openai` directly. That single seam is what makes three things possible at once. One — swap: the Anthropic, OpenAI, and Gemma providers are all just adapters behind the same contract, so the default can be local and the fallback can be cloud without the agent loop knowing the difference. Two — fixture: `FixtureModelProvider` is *also* just a `ModelProvider`, so I can replay recorded `ModelResponse[]` deterministically in tests with no network. Three — fallback: `FallbackModelProvider` is a `ModelProvider` that wraps an ordered list of other providers and tries them in sequence. All three of those — swap, test, fallback — fall out of the one contract for free. If I'd coded to the SDK directly, I'd have three different problems instead of one solved seam.

The reason this answer is so strong is that you can point at the proof: `FallbackModelProvider implements ModelProvider`, `GemmaModelProvider implements ModelProvider`, `FixtureModelProvider` — same shape, all of them. The contract isn't aspirational. It's load-bearing, and the way you prove load-bearing is the "what breaks if you remove it" test.

```
┃ "The provider contract is the one seam where swap,
┃  fixture, and fallback all become the same problem —
┃  three capabilities, one abstraction."
```

```
  "Why not call the Anthropic SDK directly?"
        │
        ▼
  You name the one seam and the three things it buys.
        │
        ├─► IF THEY ASK "isn't that premature abstraction?"
        │     No — I have FOUR real implementations behind
        │     it (Anthropic, OpenAI, Gemma, Fixture, plus
        │     Fallback). The abstraction earns its keep the
        │     moment the second implementation exists.
        │
        ├─► IF THEY ASK "what's the leakiest part?"
        │     Tool-calling. Anthropic returns native
        │     tool_use; Gemma emulates it. The contract
        │     defines the tool_use block shape and each
        │     provider's job is to produce it — Gemma the
        │     hard way.
        │
        └─► IF THEY ASK "where would this abstraction break?"
              Streaming. The contract is request/response.
              If I needed token streaming through the same
              seam I'd extend complete() or add a method —
              and I'd name that as the next design cost.
```

╔═══════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                   ║
║                                                       ║
║   They push on the embedding model itself — "why     ║
║   768 dimensions? what's nomic-embed-text doing       ║
║   internally? how does it compare to OpenAI's          ║
║   text-embedding-3?" You picked nomic because it      ║
║   runs locally over Ollama and 768 is its native       ║
║   dimension. You did NOT benchmark it against          ║
║   OpenAI's embeddings, and you haven't read the        ║
║   nomic architecture.                                 ║
║                                                       ║
║   Say:                                                ║
║   "I picked nomic-embed-text because it runs locally  ║
║    over Ollama and keeps the default path offline —   ║
║    768 is its native dimension. I haven't                ║
║    benchmarked its retrieval quality against           ║
║    OpenAI's embeddings, and I haven't gone into the    ║
║    model internals. What I made sure of is that the    ║
║    dimension is a one-way door: the VectorStore        ║
║    carries its own dimension and throws loudly on a    ║
║    mismatch, so swapping the embedding model can't     ║
║    silently corrupt a corpus. If you want to dig into  ║
║    the quality tradeoff, walk me through what you'd    ║
║    measure."                                           ║
║                                                       ║
║   What this signals: you own the integration decision ║
║   and the safety property, you're honest about the     ║
║   benchmark you didn't run, and you hand the           ║
║   interviewer the wheel instead of bluffing model      ║
║   internals. All three are senior signals.            ║
║                                                       ║
║   Do NOT say:                                         ║
║   "768 is just the standard size and nomic is          ║
║    basically as good as OpenAI's." You don't know      ║
║    that, and a follow-up will expose it instantly.     ║
╚═══════════════════════════════════════════════════════╝

---

## Choice 4 — In-memory store in aptkit, pgvector in buffr

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "An in-memory vector store isn't durable. Why      │
│    not just use pgvector everywhere?"               │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand the difference between a library │
│   and a deployment? Did you keep the reusable core   │
│   deployment-agnostic on purpose, or did you ship a  │
│   toy store because it was easy?                     │
└─────────────────────────────────────────────────────┘
```

The trap in this question is the word "durable." If you defend the in-memory store as durable, you lose. You win by reframing: the in-memory store was never supposed to be the production store. It's the library's reference implementation, and durability lives in a different repo on purpose.

> The in-memory store isn't meant to be durable — that's the point of the split. aptkit is a library; it has to stay deployment-agnostic, so it ships `InMemoryVectorStore`, a cosine scan over an array, as the reference implementation behind the `VectorStore` contract. The durable store lives in the deployment repo, buffr, as `PgVectorStore` — and it implements the *exact same* `VectorStore` contract. In buffr's `src/pg-vector-store.ts` it's literally `class PgVectorStore implements VectorStore`, importing the contract from `@rlynjb/aptkit-core`, using pgvector's `<=>` cosine-distance operator with `1 - distance` as the score. So the library never has to know whether it's running against an array or against Postgres. The cost I'm paying is that the in-memory store doesn't persist and doesn't scale past memory — but that's correct, because the library isn't where persistence belongs. Persistence is a deployment concern, and the deployment repo fills that slot.

This is your `me.md` system-design story made literal — the "library/deployment split," the same shape as buffr's canonical-local-with-cloud-mirror. The interviewer is hearing you separate policy from mechanism, and you can prove it: two implementations, one contract, the durability difference living exactly where it should.

```
┌─────────────────────────────┬─────────────────────────────┐
│ WEAK ANSWER                 │ STRONG ANSWER               │
├─────────────────────────────┼─────────────────────────────┤
│ "The in-memory store is     │ "The in-memory store is the │
│ fine for now, I'd swap it    │ library's reference impl —   │
│ for a real database          │ aptkit has to stay           │
│ later if I needed to."       │ deployment-agnostic. Durable │
│                             │ storage is a deployment      │
│                             │ concern, so PgVectorStore     │
│                             │ lives in buffr and implements│
│                             │ the same VectorStore contract│
│                             │ against pgvector. The library│
│                             │ never knows which one it's    │
│                             │ running."                    │
├─────────────────────────────┼─────────────────────────────┤
│ Why it's weak:              │ Why it works:               │
│ "Fine for now / swap it      │ Reframes durability as a     │
│ later" tells the             │ deployment concern, points   │
│ interviewer you didn't       │ at the real second           │
│ design the seam — you        │ implementation, and names the│
│ deferred it. It sounds       │ contract that makes the split│
│ like a TODO, not a           │ clean. The "cost" is now a   │
│ decision.                    │ deliberate boundary, not a   │
│                             │ loose end.                   │
└─────────────────────────────┴─────────────────────────────┘
```

```
  "Why not pgvector everywhere?"
        │
        ▼
  You reframe: library vs deployment, same contract.
        │
        ├─► IF THEY ASK "how do you know the two impls
        │   agree?"  Both honor the same dimension guard —
        │     buffr's PgVectorStore test asserts it ranks
        │     the planted chunk on top AND throws on a
        │     dimension mismatch, same as the in-memory one.
        │
        ├─► IF THEY ASK "where does the in-memory store
        │   break first?"  Memory and durability. It's a
        │     linear cosine scan; it's gone on restart and
        │     O(n) per query. Fine for the library's tests
        │     and a small corpus; wrong for production.
        │
        └─► IF THEY ASK "could you put pgvector in aptkit
            directly?"  I could, but it'd drag a Postgres
              dependency into a library that's meant to run
              anywhere. Keeping it out IS the design.
```

---

## Choice 5 — Publishing one bundled package

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "You have 15 internal packages. Why publish them   │
│    as one bundle instead of separately, or just      │
│    using git dependencies?"                         │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand the consumer's install           │
│   experience and the versioning blast radius? Did    │
│   you think about how someone clones and uses this,  │
│   or did you just run npm publish on whatever was    │
│   lying around?                                      │
└─────────────────────────────────────────────────────┘
```

This is a packaging question, which sounds boring, but it's actually a question about whether you think past your own machine. The strong answer is about the *consumer*.

> I publish exactly one package, `@rlynjb/aptkit-core`, and it bundles all 15 internal `@aptkit/*` packages via `bundledDependencies` into one standalone tarball. The monorepo root is `private: true` on purpose — it never gets published. The reason is the consumer's experience. buffr depends on `@rlynjb/aptkit-core` and imports everything from it — one install, one version number. The alternative, publishing 15 packages separately, means 15 version numbers a consumer has to keep in lockstep, and a mismatch between, say, the runtime and the retrieval package becomes the consumer's debugging problem. Git dependencies would mean the consumer clones submodules and builds my internal workspace graph themselves — they'd inherit my whole build chain. The bundle collapses all of that: a clean clone gets one tarball with all the `dist/` inlined, and one semver to track. The cost I pay is on the publishing side — `scripts/pack-core-standalone.mjs` has to pack every workspace, and every bundled package needs an explicit `files` allowlist or `npm pack` excludes its gitignored `dist/`. I moved the complexity to the producer so the consumer never sees it.

The detail that proves you actually shipped this — and didn't just describe it from a tutorial — is the gotcha. The `.gitignore` ignores `dist/`, `npm pack` honors `.gitignore`, so without `"files": ["dist/src"]` in each package, the tarball ships with no JavaScript and consumers get `has no exported member` errors. That bit you when `provider-gemma` and `provider-local` were first bundled, and it's documented in `RELEASE.md`. Naming a real scar like that is worth more than any amount of clean theory.

```
┃ "One published package, one version. I moved the
┃  packaging complexity to the producer so a consumer
┃  gets a clean clone and one semver to track."
```

```
  "Why one bundle and not 15 packages?"
        │
        ▼
  You give the consumer-experience + one-version answer.
        │
        ├─► IF THEY ASK "what's the downside of bundling?"
        │     Consumers can't pull just one package — they
        │     take all 15 or none. For a cohesive core
        │     that's fine; if someone wanted only the
        │     retrieval contracts, they over-install.
        │
        ├─► IF THEY ASK "how do you keep the bundle from
        │   shipping broken?"  Five-step release in
        │     RELEASE.md, and the files-allowlist gotcha —
        │     every bundled package needs files:["dist/src"]
        │     or its dist is gitignored out of the tarball.
        │
        └─► IF THEY ASK "what's the public API surface?"
              Whatever packages/core/src/index.ts re-exports.
              That's the compatibility contract — semver
              0.4.x — and the @aptkit/core alias has to keep
              resolving to it for host apps.
```

---

## Choice 6 — node:test + TDD over jest/vitest

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Why Node's built-in test runner instead of jest   │
│    or vitest?"                                       │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you reach for tools reflexively, or do you      │
│   match the tool to the project? Is your testing     │
│   strategy a real seam, or just "I wrote some        │
│   tests"?                                            │
└─────────────────────────────────────────────────────┘
```

This is the one choice in the chapter you should keep short — it's the least load-bearing, and over-explaining it makes it look more important than it is. But it connects to something that *is* load-bearing, so don't skip it entirely.

> I use `node --test` — Node's built-in runner — across every package, no jest, no vitest. The reason is dependency weight: this is a library that gets bundled and shipped, and a zero-dependency test setup keeps the toolchain small. But the part that actually matters isn't the runner, it's the seam the tests run against. Everything testable is built around injectable transports. `GemmaModelProvider` takes a `chat` transport in its options, so tests feed it recorded Ollama responses with no network. `FixtureModelProvider` replays recorded `ModelResponse[]` deterministically. So the testing strategy isn't a runner choice — it's that the same provider contract that buys me swap and fallback also makes everything fixture-able. The runner is incidental; the injectable seam is the design.

That last move is the one that makes this a good answer instead of a trivia answer: you redirect from the runner (which nobody cares about) to the injectable-transport seam (which is the same `ModelProvider` contract from Choice 3, seen again). Self-similarity like that — "the test seam is just the provider contract again" — is a strong signal.

```
        ▸ The test runner is trivia. The injectable
          transport is the design — and it's the same
          provider contract wearing a different hat.
```

---

## What you'd change

If I were starting aptkit today, I'd reconsider one thing in this chapter: I'd define the `VectorStore` contract to carry a capability hint for metadata filtering, instead of leaving the filter logic entirely in the `search_knowledge_base` tool. Right now the tool over-fetches (`fetchK = topK * 4`) and post-filters in memory, which is correct for the in-memory store but wasteful against pgvector, where the filter could push down into the SQL `where` clause. The contract is clean, but it's clean by hiding a cost that a durable store could avoid. I wouldn't change the provider contract or the bundle — those have earned out. But the retrieval filter is the seam where I'd spend more design time the second time around. Naming that unprompted is the move: it shows the contracts weren't accidental, and that I know exactly which one I'd refine.

---

## One-page summary — Chapter 3

**Core claim:** Every load-bearing choice in aptkit pays a named cost to buy a named capability. Defending the stack means naming both halves out loud — the benefit *and* the cost — for every choice.

**The six choices, one line each:**

| Choice | What you picked | The cost you pay |
| --- | --- | --- |
| Model | Local Gemma over Ollama (default), cloud as fallback | No native tool-calling → emulated; weaker model → guard rails (`minTopK`, lenient `matchesFilter`) |
| RAG | Contracts (`EmbeddingProvider` + `VectorStore`) over LangChain | More code I own — buys in-memory tests + no lock-in |
| Provider seam | `ModelProvider.complete()` over the vendor SDK | One abstraction — buys swap + fixture + fallback at once |
| Deployment split | `InMemoryVectorStore` in aptkit, `PgVectorStore` in buffr | In-memory isn't durable — by design; durability is a deployment concern |
| Publishing | One bundle `@rlynjb/aptkit-core` (15 pkgs) over N packages | Producer-side pack complexity (`files` allowlist gotcha) — buys one-version clean-clone install |
| Testing | `node:test` + injectable transports over jest/vitest | None worth defending — the runner is incidental; the seam is the provider contract again |

**Pull quotes to carry in:**

```
┃ "The interesting part of choosing a weak model isn't
┃  the model — it's the guard rails the weakness forces
┃  you to build."

┃ "The provider contract is the one seam where swap,
┃  fixture, and fallback all become the same problem."

┃ "One published package, one version. I moved the
┃  packaging complexity to the producer."
```

**What you'd change:** Push metadata filtering into the `VectorStore` contract so pgvector can filter in SQL instead of the tool over-fetching and post-filtering in memory.

**The one thing to remember:** Lead every choice with *why*, then volunteer the *cost* before they ask. A defaulted choice you can't explain reads junior; a paid cost you can name reads senior — even when the choice is unusual. Especially when it's unusual.
