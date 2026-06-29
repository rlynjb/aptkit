# Chapter 7 — The Counterfactuals

The senior-engineer move is to volunteer what you'd reconsider before you're
asked. When you say "if I were starting today, I'd do X differently, and
here's the criterion that would flip the decision," you signal that you make
decisions with explicit tradeoffs and you keep watching them after you ship.
Juniors defend every choice to the death. Seniors hold their decisions
loosely and name the conditions under which they'd change.

The trap in this chapter is the opposite: fabricating regrets for decisions
that were obviously right. If you say "I'd change the in-memory store, it was
a mistake," you've just told the interviewer you don't understand your own
sequencing decision. The skill is knowing which decisions are genuinely
reconsiderable and which were right — and saying so for both.

## The chapter-opening diagram — the counterfactuals matrix

Four reconsiderable decisions, each with the condition that would flip it.
Note the third one: the honest answer is "I'd flip this roughly never," and
saying that is as strong as naming a real regret.

```
THE COUNTERFACTUALS MATRIX — decision × what flips it

  ┌────────────────────┬─────────────────┬──────────────────────┐
  │ DECISION           │ FLIP CONDITION  │ WOULD I FLIP IT?     │
  ├────────────────────┼─────────────────┼──────────────────────┤
  │ local Gemma        │ reliability +   │ YES, past the demo   │
  │ default            │ latency matter  │ phase → frontier     │
  │                    │ more than       │ default. Right for   │
  │                    │ zero-key local  │ learning, wrong for  │
  │                    │                 │ a real user base.    │
  ├────────────────────┼─────────────────┼──────────────────────┤
  │ RAG from scratch   │ a production    │ YES, under deadline  │
  │                    │ deadline        │ → reach for a        │
  │                    │ instead of a    │ framework. The build │
  │                    │ learning goal   │ was to LEARN; a      │
  │                    │                 │ product would buy    │
  │                    │                 │ the connectors.      │
  ├────────────────────┼─────────────────┼──────────────────────┤
  │ in-memory store    │ ~never          │ NO. It's sequencing, │
  │ first              │ (it's           │ not debt. The        │
  │                    │ sequencing,     │ reference impl that  │
  │                    │ not debt)       │ proved the contract. │
  ├────────────────────┼─────────────────┼──────────────────────┤
  │ one bundle vs      │ a SECOND        │ YES, with multiple   │
  │ N packages         │ consumer with   │ consumers. One       │
  │                    │ different needs │ consumer = one       │
  │                    │                 │ bundle, no question. │
  └────────────────────┴─────────────────┴──────────────────────┘

  the move: name the flip CONDITION, not a vague regret. and say
  "I'd flip this roughly never" out loud when that's the truth.
```

That matrix is the chapter. Each row is a complete counterfactual with the
condition that decides it. Let's voice the two that flip and the one that
doesn't, because the "doesn't" is where most candidates fabricate a regret.

### Question 1 — "What would you do differently if you started today?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "If you were starting this project over today,    │
│    what would you do differently?"                  │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you reflect on your decisions, or defend them  │
│   reflexively? Can you name a real reconsideration  │
│   with a CRITERION — not a fake regret, not "nothing,│
│   it was all great"?                                │
└─────────────────────────────────────────────────────┘
```

> "Two things flip cleanly, and one that I'd want you to know I *wouldn't*
> change, because the reasoning matters.
>
> The clean flip is the default provider. I defaulted to a local Gemma — and
> for a learning system that was right, it was a forcing function: if the loop
> survives a weak model, it survives anything. But if aptkit had a real user
> base, defaulting to the *least* reliable provider is backwards. So today I'd
> keep Gemma as the zero-key demo path and make a frontier provider the
> default for anyone past the tutorial. The decision was right for its phase
> and wrong for the next phase — that's the flip condition: a real user base.
>
> The second flip is RAG-from-scratch versus a framework. I built it from
> scratch deliberately, to own the chunker and the ranking and the tool
> boundary. But the flip condition is a production deadline. If I were
> shipping a product on a clock, I'd reach for a framework and buy the retries
> and connectors instead of building and debugging them myself. I'd lose the
> deep understanding, but I'd ship. Different goal, different call."

That answer names the *condition* under each flip — a real user base, a
production deadline — instead of a vague "I'd probably do it better." The
condition is what makes it a senior answer: you're not regretting, you're
showing the decision was contingent on a goal that could change.

```
┃ I'm not regretting the decision. I'm naming the condition
┃ that would flip it. Those are different, and the second
┃ is the senior one.
```

### Question 2 — the decision you would NOT change

This is the one candidates blow by fabricating a regret. Hold the line.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Surely the in-memory vector store was a shortcut │
│    you regret? You'd use a real DB from the start?" │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Will you cave and invent a regret to please the   │
│   interviewer? Or can you defend a right decision    │
│   under pressure to recant it?                      │
└─────────────────────────────────────────────────────┘
```

> "No — and I want to be clear about why, because it's the decision I'd repeat
> exactly. The in-memory store wasn't a shortcut to a real database. The
> `VectorStore` contract was the product; the in-memory cosine scan was the
> reference implementation that proved the contract was enough. And the proof
> is that buffr's `PgVectorStore` implements the same contract over Postgres
> in a one-line swap. If in-memory had been a shortcut, that swap would have
> been a rewrite. So I'd flip this roughly never — it's sequencing, not debt.
>
> The *one* thing I'd change in that area is shipping a second real backend
> sooner — a third `VectorStore` implementation — so the contract was proven
> against two production stores, not just buffr's. Proving a contract once is
> good; proving it twice is when you really know the boundary holds."

Saying "I'd flip this roughly never" out loud, and then offering a *real,
smaller* refinement (a second backend) instead of caving — that's the move.
You held the line on the right decision and still gave them a genuine
reconsideration, so you don't look defensive.

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "Yeah, fair, the in-memory   │ "No — I'd repeat that one. It │
│  store was definitely a       │  wasn't a shortcut, it was    │
│  shortcut. I'd probably use   │  the reference impl that      │
│  pgvector from the start if   │  proved the VectorStore       │
│  I did it again."             │  contract — and buffr's one-  │
│                              │  line pgvector swap is the    │
│                              │  proof it worked. I'd flip it │
│                              │  roughly never. What I'd add  │
│                              │  is a SECOND backend sooner."  │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ Caved to the leading question.│ Held the line on a right      │
│ Just told the interviewer you │ decision under pressure to    │
│ don't understand your own     │ recant, with the reasoning    │
│ sequencing decision. The      │ intact — AND offered a real   │
│ interviewer was testing       │ refinement so it doesn't read │
│ whether you'd fold, and you   │ as stubborn. Passed the test  │
│ folded.                      │ the question was setting.     │
└──────────────────────────────┴──────────────────────────────┘
```

```
"What would you do differently?"
      │
      ├─► IF THEY PUSH "but really, nothing's perfect"
      │     Agreed — and the two I'd flip are provider default
      │     and from-scratch RAG, each with a clear condition.
      │     The in-memory store I'd keep, here's why.
      │
      ├─► IF THEY ASK "what about the AI-assisted parts?"
      │     The defaulted-to decisions are where I'd look first
      │     — HNSW defaults, the chunking strategy. → Ch08.
      │
      └─► IF THEY ASK "anything about the security model?"
            Honest: single-user, RLS deferred. app_id tenancy
            exists in buffr's schema but row-level security
            isn't enforced yet. I'd add it for multi-tenant. → below.
```

```
╔════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                     ║
║                                                         ║
║   They push into the security counterfactual: "You have ║
║   app_id tenancy but no RLS. Walk me through how you'd   ║
║   design the full multi-tenant isolation model — RLS    ║
║   policies, the threat model, tenant data leakage."     ║
║                                                         ║
║   buffr's schema has app_id columns (tenancy keys) but  ║
║   RLS is deferred — it's single-user. You have NOT       ║
║   designed or operated a hardened multi-tenant RLS       ║
║   model. This is a real gap.                            ║
║                                                         ║
║   Say:                                                  ║
║   "Right now it's single-user, so RLS is deliberately   ║
║    deferred — the app_id column is in the schema as the ║
║    tenancy key, but I'm not enforcing row-level          ║
║    security yet because there's one tenant. For real     ║
║    multi-tenant I'd add Postgres RLS policies keyed on   ║
║    app_id so a query can only see its own tenant's rows. ║
║    But I'll be honest — I haven't designed or run a       ║
║    hardened multi-tenant isolation model in production,   ║
║    so the threat-model details and the policy edge cases  ║
║    are something I'd work through carefully rather than    ║
║    claim from experience. The schema's ready for it; the  ║
║    enforcement and the threat model are the work I            ║
║    haven't done."                                        ║
║                                                         ║
║   What this signals: you know RLS is the mechanism and   ║
║   that app_id is the key, you framed deferral as          ║
║   deliberate (one tenant), and you're honest that          ║
║   designing the hardened model is unfinished work, not     ║
║   something you'll bluff.                                ║
║                                                         ║
║   Do NOT say:                                            ║
║   "I'd just turn on RLS, it's straightforward" — RLS      ║
║   policy design and tenant-isolation threat modeling      ║
║   are not straightforward, and saying so reveals you       ║
║   haven't done it.                                       ║
╚════════════════════════════════════════════════════════╝
```

```
        ▸ Fabricating a regret for a decision that was right is
          worse than naming no regret at all. Hold the line on
          the calls you'd repeat.
```

## What you'd change

Pulling the chapter's own thread: the single counterfactual I'd act on first
is the provider default — keep Gemma as the zero-key demo, make frontier the
default past the tutorial — because it's the one where the *right* decision
for the build phase becomes the *wrong* default the moment anyone real uses
it. The second backend to re-prove the `VectorStore` contract is the one I'd
do for my own confidence in the design. And the security model — RLS keyed on
`app_id` — is the one I'd defer until there's a second tenant, because
building isolation before you have anyone to isolate is solving a problem you
don't have yet. Knowing which counterfactuals to act on *now* versus *when a
condition is met* is itself the senior judgment this chapter is about.

## One-page summary — Chapter 7

```
CORE CLAIM
  Volunteer what you'd reconsider, named by the CONDITION that
  flips it — not vague regret. And hold the line on right calls.

DECISIONS COVERED
  FLIP: local Gemma default → frontier past the demo phase
        (condition: a real user base).
  FLIP: RAG from scratch → framework (condition: production deadline).
  KEEP: in-memory store first — sequencing not debt, I'd flip it
        roughly never. Refinement: ship a 2nd backend to re-prove
        the contract.
  FLIP: one bundle → N packages (condition: a second consumer).
  GAP:  RLS deferred, app_id tenancy exists — single-user by
        design; hardened multi-tenant model is unfinished. (box)

PULL QUOTES
  ▸ I'm naming the condition that flips it, not regretting it.
  ▸ Fabricating a regret for a right decision is worse than none.

WHAT YOU'D CHANGE
  Act on the provider default now; do the 2nd backend for design
  confidence; defer RLS until a second tenant exists. Knowing WHICH
  to act on now vs later is the judgment.
```
