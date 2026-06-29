# Options and Opportunity Cost

*Brief-answer 6: every option considered, including `do nothing`, each with
its named opportunity cost. The fork the whole brief turns on.*

Three options were on the table. The spec requires `do nothing` to be a
real one — it is, and it's the cheapest to start and the most expensive to
live with.

```
  The three options, side by side

                  DO NOTHING        ADOPT framework        BUILD substrate ★
                  ──────────        ────────────────        ─────────────────
  what            keep re-wiring    npm install             write the contracts
                  per app + weld    LangChain /             from scratch:
                  to one vendor     LlamaIndex (or a        ModelProvider +
                                    turnkey hosted agent)   Embedding/VectorStore

  day-1 cost      ~0                low (install + glue)    high (design + build)

  ongoing cost    pain compounds    framework owns your     you own maintenance +
                  every new app     control flow + API;     the semver contract
                                    upgrades break you      (@rlynjb/...0.4.x)

  control         vendor-welded     framework-welded        yours

  local-first?    only if you       depends on framework    yes — Gemma via
                  hand-build it     support; often           Ollama is the
                  again             cloud-first             default

  portfolio       another glued     "I can use a tool"      "I built the
  signal          demo app          signal                  substrate" signal

  what you LEARN  nothing new       the framework's API      RAG/agent/eval
                                                            internals
```

★ = chosen.

---

## Option A — Do nothing

Keep building each app the way AdvntrCue was built: bespoke RAG, welded to
whatever vendor that app picked.

**Opportunity cost (named):** the pain *compounds*. Every new app pays the
full plumbing cost again, and every welded app makes the eventual un-weld
more expensive. You also forfeit the portfolio signal entirely — a fifth
vendor-glued app says nothing new about a frontend→AI pivot.

```
  Do-nothing opportunity cost — the line that goes the wrong way

  cost
   │                                          ╱ keep re-wiring
   │                                      ╱
   │                                  ╱
   │                              ╱
   │        substrate ──────────────────────  (build once, reuse)
   │      ╱
   └────────────────────────────────────────────► apps shipped
        app1     app2      app3      app4
```

This is a real option, not a strawman. With exactly one consumer today
(buffr), the do-nothing math is genuinely close — see the skeptical-reviewer
file. It loses on the compounding curve and on the portfolio, not on day-1
cost.

---

## Option B — Adopt a framework (LangChain / LlamaIndex / turnkey hosted)

`npm install` a mature agent/RAG framework and glue your apps to it.

**Opportunity cost (named):** you trade **control and learning** for speed.
The framework owns your control flow and its API surface; its upgrades can
break you on its schedule, not yours. Many are cloud-first, which fights
the local-first goal. And for the pivot, "I can wire LangChain" is a weaker
signal than "I built the retrieval loop and the eval harness." You'd also
still be welded — just to the framework instead of the cloud vendor.

What adopting would have *bought* you and you gave up: turnkey RAG on day
one, batteries-included tool-calling, a maintained codebase you don't own.
That's a real cost of choosing build — name it, don't hide it.

---

## Option C — Build the substrate (aptkit) ★ CHOSEN

Write the provider-neutral contracts from scratch and ship them as one
bundle.

```
  Why build won — the four reasons, ranked by weight

  ┌─ 1. CONTROL (heaviest) ──────────────────────────────────┐
  │ provider-neutral via ModelProvider.complete() — never a   │
  │ vendor SDK directly. Swappable adapters: cloud, local     │
  │ Gemma, fallback chain. The pain was welding; this is the  │
  │ direct un-weld.                                           │
  └────────────────────────────────────────────────────────────┘
  ┌─ 2. PORTFOLIO ───────────────────────────────────────────┐
  │ the substrate IS the pivot artifact: from-scratch RAG +   │
  │ eval harness + contracts > another glued demo app.       │
  └────────────────────────────────────────────────────────────┘
  ┌─ 3. LEARNING ────────────────────────────────────────────┐
  │ you learn the internals you'd never see behind a          │
  │ framework: chunking, ANN search, agent loop budgets,      │
  │ precision@k. me.md: fundamentals become real by building. │
  └────────────────────────────────────────────────────────────┘
  ┌─ 4. LOCAL-FIRST ─────────────────────────────────────────┐
  │ Gemma-via-Ollama default, no key/no TLS. A framework      │
  │ default would re-introduce the cloud weld.               │
  └────────────────────────────────────────────────────────────┘
```

**Opportunity cost of building (named, owned):** the **build-and-maintain
time** that adopting would have spent for you, plus the **turnkey RAG**
LangChain/LlamaIndex hand you on day one. You now also own a published
semver contract (`@rlynjb/aptkit-core@0.4.x`) forever — buffr pins `^0.4.1`
and its `PgVectorStore implements VectorStore` breaks if you change the
contract shape. That maintenance burden is the price of control.

┃ The decision in one line: **for personal-tooling + portfolio, control and
┃ learning are worth more than the time adopting would save** — because the
┃ artifact's value IS the depth that building creates, and the user count
┃ (one) is too low for framework-scale convenience to pay off.

---

## The honest counter-case

This brief does not pretend build is obviously right. With **one consumer**,
a skeptic's strongest line is: *"adopt LangChain, ship buffr in a weekend,
keep the time."* That line holds on pure delivery economics. Build wins
**only** on the two axes that actually matter here — portfolio depth and
control/learning — neither of which a framework gives you. If the goal were
"ship buffr fastest," adopt wins. The goal is the pivot artifact, so build
wins. Stating which goal flips the answer is the honest version of this
choice — full pressure-test in `05`.
