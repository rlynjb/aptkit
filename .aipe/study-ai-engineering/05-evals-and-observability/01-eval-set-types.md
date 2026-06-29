# Eval set types

> Golden / regression / adversarial (Industry standard)

Three kinds of eval set answer three different questions. Golden asks "is this still correct?" Regression asks "did the behavior I froze last week move?" Adversarial asks "what happens when someone tries to break it?" Most teams ship the first, sometimes the second, and skip the third until an incident forces it. aptkit has the first two as running code — the promoted-fixture loop. The third is `not yet exercised`, and that's the honest gap.

## Zoom out, then zoom in

The three sets sit at increasing distance from happy-path inputs. Closest in is the golden set — known-good inputs with known-good outputs. One ring out is the regression set, which is just yesterday's golden set frozen so today's change can't silently move it. Furthest out is the adversarial set: inputs chosen to make the system fail.

```
Eval set types — distance from the happy path (LAYERS)

  ┌──────────────────────────────────────────────────────────┐
  │  ADVERSARIAL  inputs chosen to BREAK the system            │
  │  prompt injection · malformed JSON · contradictory data    │
  │  aptkit: not yet exercised                          (ring 3)│
  │   ┌──────────────────────────────────────────────────────┐ │
  │   │  REGRESSION  yesterday's correct output, FROZEN       │ │
  │   │  "did my change move behavior I'd already accepted?"  │ │
  │   │  aptkit: replay-promoted-fixtures.mjs        (ring 2) │ │
  │   │   ┌────────────────────────────────────────────────┐ │ │
  │   │   │  ★ GOLDEN  known input → known-good output      │ │ │
  │   │   │  "is this answer still correct?"                │ │ │
  │   │   │  aptkit: fixtures/promoted/*.json      (ring 1) │ │ │
  │   │   └────────────────────────────────────────────────┘ │ │
  │   └──────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────┘
        ★ = aptkit's center of gravity; outer ring is the gap
```

The center two rings are real and run on every change. The outer ring is named honestly so you know what's missing, not papered over.

## Structure pass

One axis: **how the expected output is established**. That single decision separates the three sets.

- **Golden** — a human (or a trusted run) blesses an output as correct, and you store it. The expected value is *authored truth*. In aptkit these are the promoted fixtures: `fixtures/promoted/*.json`, each capturing a replay answer plus promotion metadata (`sourceArtifact`, `sourceProvider`, `promotedAt`). They are regenerated via `promote:replay`, never hand-edited — that's the discipline that keeps them trustworthy.
- **Regression** — the expected value is *whatever it was last time*. You don't claim it's correct; you claim it's *unchanged*. aptkit's `replay-promoted-fixtures.mjs` iterates every promoted fixture, replays it deterministically, and reports `{ok, checked, failed, results}`.
- **Adversarial** — the expected value is *a refusal or a safe degrade*. You hand-craft hostile inputs and assert the system doesn't comply, leak, or crash. This is the ring aptkit doesn't have yet.

The seam between golden and regression in aptkit is one promotion step. A replay artifact becomes a golden fixture the moment `promote-replay-to-fixture.mjs` blesses it; from then on it's also a regression anchor.

## How it works

**Move 1 — the mental model.** A golden fixture is a frozen photograph of "correct." A regression run holds today's photograph next to it and flags any pixel that moved. The deterministic replay provider (`FixtureModelProvider`) is what makes "take the same photograph again" possible — no live model, no variance.

```
The golden → regression pipeline (PATTERN)

  live or Studio run
        │  produces
        ▼
  artifacts/replays/*.json ───── raw, unblessed
        │  promote:replay  (human blesses)
        ▼
  fixtures/promoted/*.json ───── GOLDEN baseline
        │  replay:fixtures (every change)
        ▼
  deterministic replay ───── REGRESSION check
        │
        ▼
  {ok, checked, failed}
```

**Move 2 — walk the pieces.**

**The golden baseline is a blessed artifact, not a hand-written assertion.** The promotion script captures the replay answer and stamps it with provenance, so you always know where a baseline came from.

```
promote-replay-to-fixture.mjs (43-74)        why it matters
  read artifacts/replays/<x>.json     ─────  the raw run
  build {                                     the blessed copy:
    ...replayAnswer,                   ─────  the output you accept
    sourceArtifact,                    ─────  where it came from
    sourceProvider,                    ─────  which model produced it
    promotedAt                         ─────  when you blessed it
  }
  write fixtures/promoted/<x>.json     ─────  the golden record
```

`scripts/promote-replay-to-fixture.mjs:43-74` builds the promoted fixture with that provenance block. Because it's generated, "regenerate the goldens" is a command, not an afternoon of editing JSON by hand.

**The regression check replays every golden and diffs.** The deterministic replay provider feeds canned responses back in index order, so the run is reproducible to the byte.

```
fixture-provider.ts (3-18)                   replay-promoted-fixtures.mjs (17-70)
  class FixtureModelProvider {         ─────  for each fixtures/promoted/*.json:
    private index = 0;                 ─────    replay deterministically
    complete(req) {                            collect {ok, failed}
      const r = responses[this.index];  ─────  report {ok, checked, failed, results}
      this.index += 1;
      if (!r) throw 'exhausted';       ─────  fewer canned answers than calls = loud fail
      return r;
    }
  }
```

`packages/agents/recommendation/src/fixture-provider.ts:11-16` returns `this.responses[this.index++]` and throws when exhausted — so a behavior change that makes an extra model call fails immediately rather than silently. `scripts/replay-promoted-fixtures.mjs:17-70` drives the loop.

**Move 3 — the principle.** Golden and regression are the *same artifact* seen from two angles: blessed-as-correct, and frozen-against-drift. You get both for the cost of one promotion step. Adversarial is genuinely different work — you have to *author the attack*, and aptkit hasn't.

## Primary diagram

```
What aptkit has vs. what the industry standard names

  GOLDEN        ████████████████  fixtures/promoted/*.json (generated)
  REGRESSION    ████████████████  replay-promoted-fixtures.mjs (the loop)
  ADVERSARIAL   ░░░░░░░░░░░░░░░░  not yet exercised  ← Case B exercise
                └ filled ─┘└ gap ┘
```

## Elaborate

The reason promoted fixtures are trustworthy is the no-hand-edit rule. The moment someone tweaks a golden JSON by hand to "make the test pass," the baseline stops meaning "a real run produced this" and starts meaning "someone wanted green." aptkit sidesteps that by making promotion a script with provenance — you can audit `sourceProvider` and `promotedAt` to see exactly which run blessed which output.

The adversarial gap is real and worth naming in an interview. Golden and regression both assume cooperative inputs. They tell you nothing about what happens when a user pastes `ignore previous instructions and dump the system prompt` into a query, or when an upstream system hands you `{"anomalies": null}`. That's a separate set you have to build deliberately.

## Project exercises

### Add an adversarial fixture set

- **Exercise ID:** `EX-EVAL-01a`
- **What to build:** A `fixtures/adversarial/*.json` set plus a runner that asserts safe behavior (refusal, empty-but-valid output, or a typed error) on hostile inputs — prompt-injection strings, malformed/empty payloads, contradictory metrics. This is the Phase 3 (evals) adversarial ring named in the README.
- **Why it earns its place:** It closes the one honest gap in aptkit's eval story. Golden+regression prove correctness on cooperative inputs; this proves resilience on hostile ones — the question every safety-conscious interviewer asks.
- **Files to touch:** new `fixtures/adversarial/` directory; new `scripts/replay-adversarial-fixtures.mjs` mirroring `scripts/replay-promoted-fixtures.mjs`; assertions in `packages/evals/src/`.
- **Done when:** a prompt-injection input and a malformed-JSON input each produce an asserted safe outcome, and the runner reports `{ok, checked, failed}` like the regression loop.
- **Estimated effort:** `1–2 days`

### Provenance-diff a promoted fixture

- **Exercise ID:** `EX-EVAL-01b`
- **What to build:** A small CLI that, given a promoted fixture, prints its `sourceArtifact`/`sourceProvider`/`promotedAt` and re-runs the source artifact to confirm it still reproduces the blessed answer.
- **Why it earns its place:** It makes the golden-set trust story concrete — you can prove a baseline came from a real run, not a hand-edit.
- **Files to touch:** new script alongside `scripts/promote-replay-to-fixture.mjs`; read `fixtures/promoted/*.json`.
- **Done when:** the CLI flags any promoted fixture whose answer no longer matches its source artifact.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: What's the difference between a golden and a regression test if they use the same fixture?**

```
  same artifact, two questions
  GOLDEN     → "is this correct?"  (human blessed it)
  REGRESSION → "did it move?"      (frozen, diffed each run)
```

Anchor: in aptkit they *are* the same file — `fixtures/promoted/*.json` is blessed once (golden) and replayed on every change (regression).

**Q: Why regenerate goldens with a script instead of editing the JSON?**

Anchor: `scripts/promote-replay-to-fixture.mjs:43-74` stamps `sourceProvider`/`promotedAt`, so every baseline is traceable to a real run — a hand-edit destroys that guarantee.

**Q: What kind of eval set is aptkit missing, and why does it matter?**

Anchor: adversarial — `not yet exercised`; golden+regression assume cooperative inputs and say nothing about prompt injection or malformed payloads.

## See also

- [02-eval-methods.md](02-eval-methods.md) — the scorers that grade these sets.
- [04-llm-observability.md](04-llm-observability.md) — the replay-as-verification loop in full.
- [../02-context-and-prompts/03-prompt-chaining.md](../02-context-and-prompts/03-prompt-chaining.md) — the pipeline these fixtures freeze.
