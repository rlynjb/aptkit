# Studio Guide — Reading & Evaluating Output

This guide is for **reading** what Studio shows you and **judging the quality** of an agent's
output — not for setting it up. If you're looking at a Studio screen (or the live demo) and
want to answer *"is this a good run?"*, this is the guide.

> Want to install and run Studio yourself? See [studio.md](studio.md). Want the hands-on
> evaluation workflow (running evals, promoting baselines)? See
> [studio-evaluation.md](studio-evaluation.md). Want the package API? See
> [core-api.md](core-api.md).

---

## What you're looking at

Studio is a window into AptKit's **capabilities** — the packaged agents (recommendation,
anomaly monitoring, diagnostic, query, rubric improvement, and the RAG query agent). Each
capability takes some input, runs an agent, and produces structured output. Studio shows you
that output **plus the work the agent did to get there** — so you can decide whether to trust it.

```
  one capability run, as Studio shows it
  ──────────────────────────────────────

   INPUT ─────────► AGENT RUNS ─────────► OUTPUT
   (fixture or                            (recommendations /
    a question)          │                 anomalies / answer …)
                         │
                         ├─►  TRACE   what the agent did, step by step
                         ├─►  EVAL    did it pass the quality checks?
                         └─►  METRICS turns · duration · tokens · cost
```

Four things to read on every run: the **output**, the **trace**, the **eval result**, and the
**metrics**. The rest of this guide is how to read each one — and how to turn them into a
judgment about quality.

## The home screen — the Capability Gallery

The landing page is a gallery of cards, one per capability. Each card tells you what the
capability does and whether it's `Ready` (can run live) or `Fixture ready` (replays a recorded
run deterministically). Open a card to inspect that capability's runs. This is the map; pick a
capability to start reading.

## Reading the output

Every capability produces a **structured result**, and "good" means something different for each:

| Capability | Output | What "good" looks like |
|---|---|---|
| Recommendation | ≤3 grounded recommendations | each tied to the anomaly/diagnosis, not generic advice |
| Anomaly monitoring | severity-sorted anomalies | real metric movements flagged, by category, with scope |
| Diagnostic | a hypothesis-tested diagnosis | evidence cited, a confidence that matches the evidence |
| Query | a plain-language answer | answers the question, grounded in the data it pulled |
| RAG query | a cited answer | grounded in retrieved chunks, with sources, "not found" when absent |

The first quality question is always: **is the output the right shape and actually grounded in
the input** — or is it plausible-sounding filler? The trace is how you tell the difference.

## Reading the trace — the agent's work

The trace is a stream of **events** the agent emitted while running. Reading it top to bottom
replays the agent's reasoning. The event types:

```
  step             the agent's intermediate reasoning / text
  tool_call_start  the agent decided to call a tool (name + arguments)
  tool_call_end    the tool returned (result + how long it took)
  model_usage      tokens spent on a model turn (input/output)
  warning / error  something went sideways
```

What to look for, and what it tells you about quality:

- **Did the agent call the tools you'd expect?** A query agent that never calls a data tool and
  answers anyway is guessing. A RAG agent should `tool_call_start` a `search_knowledge_base`
  before it answers.
- **Look at the tool *arguments*** in `tool_call_start`. The wrong query or a nonsense filter
  here is a common cause of bad answers — the agent asked the wrong question.
- **Look at the tool *result*** in `tool_call_end`. **An empty result is the single sharpest
  warning sign**: the agent retrieved nothing, so anything it says next is ungrounded. (A real
  failure mode: a RAG run that confidently answers "not available" — the trace shows the search
  returned zero rows because the agent passed a bad filter.)
- **Count the turns.** A run that burns its turn budget calling tools in circles and then
  synthesizes from nothing is lower quality than a tight 1–2 tool-call run.

> The output tells you *what* the agent said. The trace tells you *whether you should believe it.*

## Reading the eval result

Each run carries an **eval block**: a name, a pass/fail (`ok`), and a list of `issues` (each a
path + message). This is the automated quality check.

The thing to internalize: **a passing eval is necessary, not sufficient.** AptKit's evals come in
two flavors, and they answer different questions:

- **Structural checks** (shape / required fields) — "is the output the right *form*?" A passing
  structural eval means the recommendation array exists, the fields are present, the types are
  right. It does **not** mean the content is correct.
- **Quality checks** — "is the content *good*?" These are the ones that judge substance:
  - **Detection precision/recall** — for things like anomaly detection: did it catch the real
    anomalies (recall) without inventing fake ones (precision)?
  - **Faithfulness (LLM-as-judge / rubric)** — for free-form answers: is the answer actually
    grounded in what was retrieved, or hallucinated? (The judge is a *stronger* model than the
    one being judged — you don't let a model grade its own homework.)
  - **precision@k / recall@k** — for retrieval (the RAG agent): of the chunks it pulled, how many
    were relevant, and did it find the ones that mattered?

So when you read `ok: true`, ask: *which* eval passed? If it's only the structural check, you
still have to read the output and trace yourself to judge quality. If a quality eval passed,
that's a stronger signal.

## Judging quality — the read, in order

```
  is the OUTPUT the right shape? ──no──► fail. stop.
            │ yes
            ▼
  did the TRACE call the right tools,
  with sane args, and get real results? ──no──► ungrounded. distrust the output.
            │ yes
            ▼
  did a QUALITY eval pass
  (detection / faithfulness / precision@k)? ──no──► right shape, wrong substance.
            │ yes
            ▼
  does the output read as grounded in
  the retrieved/observed data?  ──────────────► trust it.
```

The senior read is never "the eval is green, ship it." It's: shape → grounding (trace) →
substance (quality eval) → a human glance at whether the answer actually follows from the data.

## Comparing fixture vs live

Studio can show the same capability two ways: a **fixture** run (a recorded, deterministic
baseline) and a **live** run (a real model call). Reading them side by side is how you judge a
*model*, not just a run:

- The fixture is your **known-good baseline** — it's what a correct run looks like.
- The live run is the model under test. If its output, trace, or eval **drifts** from the fixture
  (fewer anomalies found, a missing citation, a failed faithfulness check), that drift is your
  quality signal.

This is also how regressions show up: a promoted fixture is a frozen correctness baseline, and a
live run that no longer matches it is telling you something changed.

## Analyzing across runs

Beyond a single run, the questions are:

- **Consistency** — does the capability produce stable output across fixtures, or does quality
  swing run to run? (Local/weaker models swing more; that's itself a finding.)
- **Where it breaks** — group failing runs by *which* eval failed. All structural failures point
  at output shape; clustered faithfulness failures point at the model hallucinating; precision@k
  failures point at retrieval, not the model.
- **Cost vs quality** — the metrics (tokens, cost, turns) next to the eval result let you read
  whether a quality gain is worth the spend.

## Where to go deeper

- **[studio-evaluation.md](studio-evaluation.md)** — the hands-on workflow: run an eval, read the
  replay-artifact JSON, the exact eval functions, and how to promote a run to a baseline.
- **[core-api.md](core-api.md)** — the `@rlynjb/aptkit-core` API, including the eval scorers
  (`scorePrecisionAtK`, `scoreDetections`, `RubricJudge`) behind what Studio displays.
- **[studio.md](studio.md)** — running Studio locally.
