# Options and Opportunity Cost

Answer 6: the fork. Three real options — **build**, **adopt**, **do nothing** — each with its opportunity cost named without flinching. Coach posture: a review room doesn't punish you for the path you took; it punishes you for not being able to name what the *other* paths would have bought. The chosen option is only defensible once the rejected ones are stated at full strength.

## The fork, at a glance

```
  THREE OPTIONS — what each buys, what each costs

  ┌─ A: BUILD the substrate (aptkit) ── CHOSEN ──────────────┐
  │  buy:  learning depth · local-first · provider-neutral ·  │
  │        portfolio artifact · full control of the seams     │
  │  cost: weeks of plumbing a framework gives for free;      │
  │        you maintain it; no community/ecosystem behind it   │
  └────────────────────────────────────────────────────────────┘
  ┌─ B: ADOPT a framework (LangChain / LlamaIndex / hosted) ─┐
  │  buy:  RAG + agent loop + tool-calling on day one;        │
  │        ecosystem, integrations, someone else's bugfixes   │
  │  cost: vendor/framework lock-in returns; shallow learning; │
  │        a weaker pivot-portfolio signal; abstraction you    │
  │        don't control sitting on your hot path              │
  └────────────────────────────────────────────────────────────┘
  ┌─ C: DO NOTHING (keep re-wiring per app) ─────────────────┐
  │  buy:  zero substrate cost now; ship the next app fast    │
  │        on familiar bespoke plumbing                       │
  │  cost: the re-wiring tax compounds per app; lock-in        │
  │        per app; NO portfolio artifact for the pivot;       │
  │        the pain you already named never gets solved        │
  └────────────────────────────────────────────────────────────┘
```

## Option A — build the substrate (chosen)

**What it is:** build aptkit — a provider-neutral TS monorepo, one published bundle `@rlynjb/aptkit-core@0.4.1` over 16 packages, with `ModelProvider.complete()` + `EmbeddingProvider`/`VectorStore` as the load-bearing contracts, RAG from scratch, evals (precision@k / recall@k + rubric-judge), and local Gemma via Ollama.

**What it buys:**
- **Learning depth.** RAG, the agent loop, tool-calling emulation, and the eval harness are built from scratch — which is exactly how fundamentals become real for this reader (`me.md`: "you don't trust the fundamentals until you've built with them"). A framework would have *hidden* the very mechanisms the pivot needs to demonstrate understanding of.
- **Local-first + provider-neutral control.** The default runs Gemma on Ollama with no cloud call; cloud SDKs are swappable adapters behind one contract (`context.md` stack + seams). Rein owns the seam, not a framework.
- **A portfolio artifact.** A from-scratch, evaluated, *consumed-by-a-second-repo* substrate is a sharper proof of AI-engineering depth than a LangChain wiring demo. The portfolio is the explicit purpose of the pivot (`me.md`).

**The opportunity cost (named, not softened):**
> ┃ Weeks of substrate work — provider adapters, a RAG pipeline, an eval
> ┃ harness, a publish/bundle flow — that LangChain or LlamaIndex would have
> ┃ handed over on day one. Rein now maintains all of it. There is no
> ┃ ecosystem, no community bugfixes, no integrations she didn't write.

This cost was paid **deliberately** — the learning, control, and portfolio value were judged worth more than the time, *for a personal-tooling + portfolio problem with no delivery deadline driven by users.* For a problem *with* external users and a ship date, the calculus would flip toward Option B. That honesty is the defense.

## Option B — adopt an off-the-shelf framework

**What it is:** build the apps on LangChain / LlamaIndex (or a turnkey hosted agent) and skip the substrate entirely.

**What it buys:** RAG, the agent loop, tool-calling, retrievers, and vector-store integrations on day one. An ecosystem. Someone else maintaining the plumbing.

**Why it was rejected (each reason a reviewer can test):**
- **Lock-in returns through the front door.** The original pain was welding to one vendor (AdvntrCue → GPT-4). Adopting a heavy framework trades a *vendor* weld for a *framework* weld — the abstraction you don't control now sits on your hot path. **INFERENCE:** that the framework weld is as costly as the vendor weld; a reviewer could argue a framework's provider abstraction is *better* than hand-rolling. The honest counter is that the goal was to *understand and own* the abstraction, not to consume one.
- **Shallow learning.** A framework does the interesting parts for you — the emulated tool-calling for a model with none, the dimension-mismatch one-way door, the precision@k harness. Adopting means never building them, which for a pivot portfolio is the wrong trade.
- **Weaker pivot signal.** "I wired up LangChain" reads differently in an AI-engineering interview than "I built a provider-neutral agent substrate from scratch, evaluated it, and shipped it to a second app." **EVIDENCE** for the framing: the portfolio-as-pivot-case is the spine of `me.md`.

**The opportunity cost of Option B:** the learning depth, the control, and the portfolio differentiation — exactly what Option A buys. Naming this is what makes the rejection defensible: B wasn't dismissed, it was *out-valued* for this specific problem.

## Option C — do nothing (the real baseline)

**What it is:** don't centralize anything. Keep building each app's RAG/agent plumbing bespoke, the way AdvntrCue was built. This is the genuine null option, and a review room expects it on the table.

**What it buys:** zero substrate cost today. The next app ships fast on familiar, hand-rolled plumbing Rein already knows how to write.

**The opportunity cost (why do-nothing loses):**
> ┃ The re-wiring tax compounds — paid again per app, forever. Each app stays
> ┃ vendor-welded and can't move models. And critically: there is NO portfolio
> ┃ artifact for the pivot. The problem Rein actually has — proving
> ┃ AI-engineering depth to land the next role — goes unsolved. Do-nothing is
> ┃ cheapest now and most expensive against the goal that matters.

**INFERENCE:** "the tax compounds per app" is the same forward-looking claim flagged in `01` — at decision time there was one data point (AdvntrCue), not a measured trend. The reviewer-proof version: do-nothing fails *not* primarily on compounding plumbing cost (which is small in a small portfolio) but on the **portfolio/learning axis**, which is the dominant term in this problem.

## The decision, in one frame

```
  WHY A BEAT B AND C — scored on the axes that dominate THIS problem

  axis              A: build   B: adopt   C: do nothing
  ────────────────  ────────   ────────   ─────────────
  learning depth      HIGH       low         none
  portfolio signal    HIGH       med         none
  local-first ctrl    HIGH       med*        per-app
  time-to-first-app   low        HIGH        HIGH
  maintenance burden  HIGH       low         med

  * framework-dependent; not all give local-first cleanly

  dominant axes for a personal-tooling + PORTFOLIO problem
  with NO user deadline → learning depth + portfolio signal.
  A wins those outright; it pays for them in time + maintenance.
```

▸ The call holds because the **dominant axes are learning and portfolio**, not time-to-ship — and on a different problem (users, deadline) the same scoring would pick B. Stating that the decision is *contingent on the problem's shape*, not universal, is the staff-level move.

## See also

- `01-problem-brief.md` — the pain that frames the fork
- `02-scope-cuts-and-non-goals.md` — the smallest slice the chosen option shipped
- `05-skeptical-reviewer-questions.md` — "why not just use LangChain?" defended in full
