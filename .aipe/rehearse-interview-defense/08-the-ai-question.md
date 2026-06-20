# Chapter 8 — The AI question

## Opening hook

Here's the question that ends a lot of interviews badly: "Did you use AI to build this?" The candidates who fail it do one of two things. They get defensive — "well, I wrote most of it myself" — and the interviewer's antenna goes up, because now you sound like you're hiding something. Or they over-credit the tool — "yeah, Claude basically built it" — and the interviewer hears: *this person can't own their own work*. Both answers lose. And they lose for the same reason: they treat AI use as something to apologize for instead of something to account for.

In 2026 the interviewer already assumes you used AI. They use it too. The question isn't "did you cheat." The question is "do you understand what you shipped well enough to own it." This chapter teaches you the calibrated-honest answer for aptkit and buffr: yes, you built this collaboratively with an AI coding agent, test-driven the whole way — and the engineering was in the *judgment* and the *verification*, not in the typing. You're going to learn to name three modes of decision-making, defend each one differently, and tell two war stories where you caught the AI being wrong. By the end you'll be able to say, plainly, "I used AI agents to build an AI-agent toolkit. The work was the contracts, the evals, and catching the mistakes." That answer wins.

## The chapter-opening diagram

The whole chapter lives in one picture: every decision in this codebase falls into one of three modes, and you defend each mode differently. Here's the split.

```
  WHO DECIDED WHAT — the three decision modes in aptkit/buffr

  ┌───────────────────────────────────────────────────────────────┐
  │ MODE 1 — DELIBERATE          (your call, AI executed)         │
  │   provider-neutral RAG built from contracts, not a framework  │
  │   local-first Gemma, cloud (Anthropic/OpenAI) fallback ready  │
  │   aptkit-library / buffr-deployment repo split               │
  │   eval-driven iteration (precision@k / recall@k gates)        │
  │   publishing the bundle to npm (@rlynjb/aptkit-core@0.4.0)    │
  │   ── defend by: naming the goal and the alternative rejected  │
  └───────────────────────────────────────────────────────────────┘
                              │
  ┌───────────────────────────────────────────────────────────────┐
  │ MODE 2 — EVALUATED & ACCEPTED (AI proposed, you judged)       │
  │   the VectorStore / EmbeddingProvider contract shapes        │
  │   the minTopK floor (stop a weak model starving retrieval)   │
  │   the hallucinated-filter tolerance fix                      │
  │   dropping the chunks→documents FK to keep drop-in parity    │
  │   ── defend by: naming the criterion you judged it against   │
  └───────────────────────────────────────────────────────────────┘
                              │
  ┌───────────────────────────────────────────────────────────────┐
  │ MODE 3 — DEFAULTED-TO        (AI's default, not deeply judged)│
  │   some package.json conventions / "files" field per package  │
  │   some file layout under packages/*                          │
  │   ── defend by: OWNING it — "I didn't deeply evaluate that;  │
  │      here's how I'd check it." Riskiest. Most senior when     │
  │      owned honestly.                                          │
  └───────────────────────────────────────────────────────────────┘

         the differentiator isn't "did you use AI"
         it's "can you place every decision in the right box"
```

The interviewer is trying to find out which box your decisions actually live in — and whether you'll be honest when one of them is Mode 3.

## The body — questions and defenses

### Question 1 — "Did you use AI to build this?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Did you use AI to build this?"                   │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Not whether you used it — they assume you did.    │
│   They want to see your *posture*. Defensive means  │
│   you're hiding the seams. Over-crediting means     │
│   you can't own your work. Matter-of-fact, with a   │
│   clear account of who decided what, is the only    │
│   answer that reads as senior.                      │
└─────────────────────────────────────────────────────┘
```

Lead with yes, then immediately reframe the work. Here's the answer in your voice:

"Yes — I built aptkit and its companion runtime buffr collaboratively with Claude Code, test-driven throughout. I'll be precise about what that means, because it's the interesting part. The AI did a lot of the typing. I did the contracts, the evals, and the verification. The whole repo is a provider-neutral agent toolkit — a bounded agent loop, swappable model providers, a from-scratch RAG pipeline behind `EmbeddingProvider` and `VectorStore` contracts — and I drove every one of those shapes. I used AI agents to build an AI-agent toolkit. The engineering was in the judgment, not the keystrokes."

That last line is the one to memorize. It does two things at once: it's honest about heavy AI use, and it relocates the engineering to exactly where a senior would expect it — design and verification.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I used it a bit for    │ "Yes — built it with    │
│ boilerplate, but I      │ Claude Code, test-      │
│ wrote the important     │ driven. The AI did the  │
│ parts myself."          │ typing; I did the       │
│                         │ contracts, the evals,   │
│                         │ and the verification.   │
│                         │ I drove the design and  │
│                         │ caught the AI's         │
│                         │ mistakes."              │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ It's defensive and      │ Matter-of-fact, no      │
│ vague. "A bit" and      │ flinch. Relocates the   │
│ "the important parts"   │ engineering to design   │
│ are dodges. The         │ and verification — the  │
│ interviewer now wants   │ part a tool can't do     │
│ to test whether you     │ for you — and invites    │
│ understand the parts    │ the drill instead of    │
│ you claim you wrote.    │ deflecting it.          │
└─────────────────────────┴─────────────────────────┘
```

```
┃ "I used AI agents to build an AI-agent toolkit.
┃  The work was the contracts, the evals, and the
┃  verification."
```

### Question 2 — "So did the AI write all of it? What did YOU actually do?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Did the AI write all of it? What did you         │
│    actually do?"                                    │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Can you separate the parts you DROVE from the     │
│   parts you accepted? A candidate who claims they   │
│   drove everything is lying; a candidate who        │
│   claims they drove nothing is useless. The senior  │
│   answer names the three modes and puts real        │
│   decisions in each.                                │
└─────────────────────────────────────────────────────┘
```

This is where you bring out the three-mode split. Don't recite it as a framework — walk it with real decisions. Your voice:

"I'll split it three ways. First, the deliberate calls — those were mine, the AI just executed them. The big one is that the RAG pipeline is built from *contracts*, not a framework. `EmbeddingProvider` and `VectorStore` are vendor-neutral interfaces in `packages/retrieval/src/contracts.ts`; the pipeline logic never names nomic or pgvector. That's why buffr can drop in a `PgVectorStore` against the exact same contract. I also decided the repo split — aptkit is the deployment-agnostic library, buffr is the Supabase-backed body that consumes `@rlynjb/aptkit-core` from npm. And I decided to gate retrieval changes on `precision@k` and `recall@k` scorers in `packages/evals`, and to publish the bundle to npm at `@rlynjb/aptkit-core@0.4.0`. Those are goals — the AI doesn't pick your goals.

Second, the evaluated-and-accepted calls. Claude proposed the contract *shapes* and I judged them against one question: can a swap happen without rewriting the pipeline? It proposed the `minTopK` floor and the hallucinated-filter tolerance — I accepted both after I understood the failure they prevented. And dropping the chunks→documents foreign key was a proposal I accepted once I saw it would otherwise break drop-in parity.

Third — and I want to be straight about this — there's a tier I *defaulted to*. Some of the per-package `package.json` conventions and some of the file layout under `packages/*` I took as the AI's defaults without deeply evaluating them. I can tell you which ones and how I'd check them if it mattered."

That third paragraph is the one that wins the room. We'll come back to it.

```
┃ "The AI doesn't pick your goals. Provider-neutral,
┃  contracts-not-a-framework, the repo split, eval
┃  gates — those were mine."
```

### Question 3 — "How do I know YOU understand it, and not just the AI?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "How do I know you actually understand this       │
│    code, instead of just accepting what the AI      │
│    produced?"                                        │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   The real probe. Comprehension under pressure.     │
│   They want evidence you can REASON about the code,  │
│   not recite it. The proof is: design decisions you  │
│   can justify, bugs you diagnosed that the AI        │
│   caused, and the ability to defend any choice when  │
│   pushed. Memorized lines collapse on the second     │
│   follow-up; understanding doesn't.                  │
└─────────────────────────────────────────────────────┘
```

Don't answer this with a claim ("I understand it, I promise"). Answer it with evidence — point at the design decisions, then tell a war story where you caught the AI being wrong. The catch is the proof, because you can only catch a mistake in code you actually understand.

Your voice:

"Three pieces of evidence. First, the design — I can defend every load-bearing choice in this repo and tell you the alternative I rejected. Ask me about the provider neutrality, the repo split, the eval gates, any of it. Second, I caught the AI's mistakes — and you can only catch a bug in code you understand. Let me give you the clearest one.

The `VectorStore` contract is a drop-in seam: buffr's `PgVectorStore` has to satisfy the same interface as the `InMemoryVectorStore`, so a host app can swap storage without touching pipeline code. When the AI generated buffr's SQL schema, it added a foreign key from `agents.chunks.document_id` to `agents.documents.id` — which is the *correct* instinct for a normalized schema. But the `VectorStore.upsert` contract takes chunks that carry no notion of a documents row. So the FK meant: try to upsert a chunk live, and Postgres rejects it because the parent document doesn't exist. That broke drop-in parity. And here's the part that matters — it didn't surface in fixtures, because fixtures don't hit a real database. I only caught it by running buffr live against actual Postgres. The fix is in `buffr/sql/001_agents_schema.sql`: the `document_id` column is a soft link with no FK, with an explicit comment saying why, plus an idempotent `drop constraint if exists` for already-migrated databases.

Third — and this is the deepest one — I diagnosed a *retrieval* miss. A weak local model would call `search_knowledge_base` with a hallucinated filter key, like `{textContains: "moon"}`, that no chunk's metadata actually carries. A naive exact-match filter would then exclude *every* result and the model would answer from nothing. The fix in `packages/retrieval/src/search-knowledge-base-tool.ts` is that a filter key only excludes a hit that *has* that key with a different value — absent keys are ignored. There's a test for it that asserts a hallucinated filter key doesn't zero out retrieval. Same file has the `minTopK` floor: a weak model that asks for `top_k: 1` starves its own multi-part answer, so the floor lifts it back up.

If you want to test my understanding directly — open any file and I'll walk it. The catches are the proof I'm not reciting."

```
┃ "You can only catch a bug in code you understand.
┃  The FK that broke drop-in parity is my proof I
┃  understood the contract."
```

Notice the structure of that FK story — it's a complete diagnosis, not a vague "I fixed some bugs." It names the contract that broke, *why* the AI's instinct was reasonable, why fixtures hid it, how live running surfaced it, and where the fix lives. That's what comprehension sounds like under pressure.

Here's the side-by-side for the war story, because the failure mode here is subtle:

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "The AI made some       │ "It added a chunks→     │
│ mistakes and I fixed    │ documents FK — a sane   │
│ them. Like there was a  │ normalization instinct  │
│ database bug and a      │ — but it broke the      │
│ retrieval bug."         │ VectorStore drop-in     │
│                         │ contract: upsert takes  │
│                         │ chunks with no parent   │
│                         │ row. Fixtures hid it;    │
│                         │ running buffr live      │
│                         │ against Postgres        │
│                         │ surfaced it. Fix is the │
│                         │ soft link in            │
│                         │ 001_agents_schema.sql."  │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ No specifics. "Some     │ Names the contract,     │
│ mistakes" could be      │ why the AI's call was   │
│ anything. The           │ reasonable, why tests   │
│ interviewer can't tell  │ missed it, how it was    │
│ if you diagnosed it or  │ found, where the fix     │
│ the AI fixed its own    │ lives. This is a        │
│ bug. No proof of        │ diagnosis only the      │
│ understanding.          │ author could give.      │
└─────────────────────────┴─────────────────────────┘
```

### The follow-up decision tree

Once you've given the three-mode answer, the interviewer will push on one branch. Here's where it goes and what to say.

```
"How do I know you understand it?"
      │
      ▼
You point at design + the war-story catches.
      │
      ├─► IF THEY OPEN A FILE AND SAY "WALK ME THROUGH THIS"
      │     Do it live. Lead with the contract or the
      │     shape, then the mechanism. You can defend
      │     every choice in this book — that's the whole
      │     point of having written it.
      │
      ├─► IF THEY ASK "WHAT ELSE DID THE AI GET WRONG?"
      │     Have the second war story ready: the
      │     hallucinated-filter retrieval miss in
      │     search-knowledge-base-tool.ts, and the
      │     minTopK floor. Two catches beat one.
      │
      ├─► IF THEY PUSH ON A MODE-3 DEFAULT
      │     ("did you evaluate this package.json setup?")
      │     OWN IT. "No — I took the AI's default there.
      │     Here's how I'd check it." Do not fake having
      │     evaluated it. The honest answer is the
      │     senior signal. (See the recovery box.)
      │
      └─► IF THEY ASK "WOULD YOU TRUST THIS IN PRODUCTION?"
            Point at the testing backbone: node:test
            across 28 test files, eval gates on
            retrieval (precision@k), live-run
            verification that caught the FK. The
            verification IS the trust story.
```

### Question 4 — "Isn't using AI for all this just... cheating?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "If the AI wrote most of the code, what's the     │
│    actual skill here?"                              │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Whether you can articulate the 2026 differentiator │
│   without sounding defensive about it. The baseline  │
│   assumes heavy AI use. The skill is judgment and    │
│   verification — and they want to hear you say that  │
│   like it's obvious, because to a senior, it is.     │
└─────────────────────────────────────────────────────┘
```

Your voice, calm and matter-of-fact:

"The skill is the same skill it's always been, just with the typing compressed. The AI will happily generate a normalized schema with a foreign key that breaks my drop-in contract, or a retrieval filter that wipes results when a weak model hallucinates a key. It generates plausible code fast. What it doesn't do is decide that the `VectorStore` contract is the thing that must not break, run the system live against real Postgres to find where the plausible code fails, or build precision@k gates so a retrieval regression can't merge silently. That's the work. I came into this already understanding RAG — I shipped a pgvector-backed RAG app, AdvntrCue, before this — so I was driving the retrieval design from experience, not discovering it from the AI's output. The AI accelerated the build. It didn't supply the judgment."

```
        ▸ The 2026 baseline assumes heavy AI use.
          The differentiator is judgment and
          verification — owning which decisions
          were yours and proving you can catch
          the tool when it's wrong.
```

## When you don't know

The riskiest question in this chapter isn't a hard technical one — it's the interviewer pushing on a Mode-3 default and watching whether you'll fake it. This is the box to internalize.

```
╔═══════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                   ║
║                                                       ║
║   They push on a defaulted-to decision — something    ║
║   the AI set up that you didn't deeply evaluate.      ║
║   For aptkit, that's some of the per-package          ║
║   package.json conventions (the `"files": ["dist/    ║
║   src"]` field every bundled package needs, the       ║
║   bundledDependencies setup) and some file layout     ║
║   under packages/*.                                   ║
║                                                       ║
║   Say:                                                ║
║   "Honestly — I didn't deeply evaluate the per-       ║
║    package package.json conventions. The AI set       ║
║    those up and I confirmed the bundle published      ║
║    and resolved, but I took the layout as its         ║
║    default. If I needed to defend it, I'd check       ║
║    that every bundled package has its `files` field   ║
║    set so npm pack doesn't drop a gitignored dist,    ║
║    and I'd diff the published tarball contents        ║
║    against what core re-exports. I know how I'd       ║
║    verify it; I just haven't had to."                 ║
║                                                       ║
║   What this signals: you can DISTINGUISH the          ║
║   decisions you drove from the ones you accepted on   ║
║   default, AND you have a concrete verification       ║
║   path for the ones you didn't. That's the most       ║
║   senior thing you can do in this chapter. It's the   ║
║   opposite of fragile.                                ║
║                                                       ║
║   Do NOT say:                                         ║
║   "Yeah I set all that up deliberately, the package   ║
║    structure is designed for..."                      ║
║   The moment you over-claim a Mode-3 default, the     ║
║   interviewer asks one more question and watches you  ║
║   improvise. Faking ownership of a default is how a   ║
║   strong interview turns into a failed one.           ║
╚═══════════════════════════════════════════════════════╝
```

The grounding here is real: `RELEASE.md` documents that each new bundled package needs `"files": ["dist/src"]` or `npm pack` excludes its gitignored `dist`. That's exactly the kind of convention that's easy to default to and easy to verify *later* — which is precisely why it's the safe, honest Mode-3 example to name.

```
┃ "I didn't deeply evaluate that — but here's how
┃  I'd check it." Owning a default is more senior
┃  than faking a deliberate choice.
```

## What you'd change

If you were doing this again, the thing to change is the *verification gap that the FK bug exposed*. The foreign key broke drop-in parity and fixtures didn't catch it — only running buffr live did. The honest reflection: I leaned on fixtures for fast deterministic replay, which is the right backbone, but I had no contract-conformance test that ran a real adapter against the real `VectorStore` interface. If I started over, I'd add a shared contract test suite that every `VectorStore` implementation — in-memory and `PgVectorStore` — has to pass, so a parity-breaking change like that FK fails in CI instead of in a live run. The fixtures stay; I'd add the conformance layer underneath them. That's the senior move: I don't regret the fixtures, I name the specific gap the bug revealed and the test that would have closed it.

## One-page summary

**Core claim:** The 2026 baseline assumes you used AI heavily. The differentiator is judgment and verification — owning which decisions were yours, which you evaluated and accepted, which you defaulted to, and proving you can catch the tool when it's wrong.

**The three modes (memorize this split):**
- **Deliberate (your call):** provider-neutral RAG from contracts, local-first Gemma with cloud fallback, the aptkit/buffr repo split, eval gates (`precision@k`/`recall@k`), publishing `@rlynjb/aptkit-core@0.4.0` to npm.
- **Evaluated & accepted (AI proposed, you judged):** the `VectorStore`/`EmbeddingProvider` contract shapes, the `minTopK` floor, the hallucinated-filter tolerance, the FK removal.
- **Defaulted-to (own it honestly):** some `package.json` conventions, some `packages/*` layout. "I didn't deeply evaluate that; here's how I'd check it."

**Questions covered:**
- *Did you use AI to build this?* → "Yes, with Claude Code, test-driven. The AI did the typing; I did the contracts, the evals, and the verification."
- *Did the AI write all of it / what did YOU do?* → Walk the three modes with real decisions in each.
- *How do I know YOU understand it?* → Point at design decisions + the war-story catches. The FK that broke drop-in parity (`buffr/sql/001_agents_schema.sql`) and the hallucinated-filter miss (`packages/retrieval/src/search-knowledge-base-tool.ts`) are proof, because you can only catch a bug in code you understand.
- *Isn't this cheating?* → The AI generates plausible code fast; it doesn't supply judgment or verification. I came in already understanding RAG (shipped AdvntrCue before this).
- *Pushing on a Mode-3 default?* → Own it. Name how you'd verify it. Never fake deliberate ownership of a default.

**Pull quotes:**
```
┃ "I used AI agents to build an AI-agent toolkit.
┃  The work was the contracts, the evals, and the
┃  verification."

┃ "You can only catch a bug in code you understand."

┃ "I didn't deeply evaluate that — but here's how
┃  I'd check it."
```

**What you'd change:** Add a shared `VectorStore` contract-conformance test suite that every implementation (in-memory and `PgVectorStore`) must pass, so a parity-breaking change like the FK fails in CI instead of in a live run. Keep the fixtures; add the conformance layer underneath.
