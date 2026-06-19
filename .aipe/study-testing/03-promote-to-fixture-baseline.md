# Promote-to-fixture baseline (golden-master lifecycle)

**Industry names:** golden master · snapshot/approval testing · characterization test
· record-then-freeze. **Type:** Industry standard (adapted to an LLM).

## Zoom out, then zoom in

```
  Zoom out — the lifecycle spans three storage zones

  ┌─ Live (costs tokens, non-deterministic) ─────────────────┐
  │  replay:model / replay:openai → real provider            │
  └─────────────────────────────┬─────────────────────────────┘
                                │ writes
  ┌─ artifacts/replays/*.json (captured, gitignored) ─────────┐
  │  eval:replays validates shape + secrets                   │ ← ★ gate ★
  └─────────────────────────────┬─────────────────────────────┘
                                │ promote:replay (after review)
  ┌─ fixtures/promoted/*.json (frozen, committed) ────────────┐
  │  replay:promoted → deterministic regression test          │
  └────────────────────────────────────────────────────────────┘
```

You know how a snapshot test captures a component's rendered output once, you eyeball
it, commit it, and every later run diffs against the frozen snapshot? Same idea — but
the "render" is an expensive non-deterministic LLM run, so the lifecycle has an extra
gate: you don't commit the raw capture, you *eval* it first, then promote a good one
into a frozen baseline. That's the pattern: **record a live run, prove it's
well-formed, freeze it as the regression baseline.**

## Structure pass

**Layers:** live capture → artifact → eval gate → promoted fixture → replay.

**Axis — trust (can you depend on this output as ground truth?):** trace it down.

```
  One question down the lifecycle: "can I trust this as a baseline?"

  ┌─ live artifact ──────────────┐  NO — unreviewed, may be wrong/leaky
  └──────────────┬───────────────┘
  ┌─ eval:replays passes ────────▼┐  PARTIALLY — well-formed, not yet reviewed
  └──────────────┬────────────────┘
  ┌─ human review + promote ─────▼┐  YES — frozen, committed, "correctness baseline"
  └──────────────┬────────────────┘
  ┌─ replay:promoted ────────────▼┐  it IS the ground truth now
  └────────────────────────────────┘
```

**The seam:** `promote:replay`. Trust flips across it — before, the JSON is a
disposable experiment; after, it's a committed correctness baseline that the project
context explicitly says you must NOT hand-edit. The promotion is where a live
artifact becomes load-bearing test data.

## How it works

### Move 1 — the mental model

```
  The golden-master loop — capture once, replay forever

   ┌─────────┐  run once   ┌──────────┐  eval   ┌─────────┐
   │  live   │ ──────────► │ artifact │ ──────► │ promote │
   │  model  │  (tokens)   │  (json)  │ (gate)  │ (freeze)│
   └─────────┘             └──────────┘         └────┬────┘
        ▲                                            │
        │                                            ▼
        │                                    ┌───────────────┐
        └── only when you intentionally ──── │ replay:promoted│
            re-capture a new baseline        │ (0 tokens, det)│
                                             └───────────────┘
```

The strategy: **the expensive output becomes the expected output.** You run the
non-deterministic thing once under supervision, bless the result, and from then on
"correct" means "matches the blessed result."

### Move 2 — step by step

**Step 1 — capture a live run.** `replay:model` / `replay:openai` runs the real
provider and writes `artifacts/replays/<timestamp>-<fixture>-<provider>.json`. The
artifact carries everything: `schemaVersion`, `createdAt`, `durationMs`,
`provider`, `fixture` (id + path), the output (recommendations/anomalies/etc.),
`trace`, embedded `eval`, and `modelTurns`. This is the data model both this guide
and `study-data-modeling` lean on.

**Step 2 — eval the capture (the gate).** `eval:replays` runs
`assertCapabilityReplayArtifactShape` over every artifact: shape is valid, embedded
`eval.ok === true`, no secret-like strings. An artifact that fails is not
promotable.

```
  promote refuses a malformed artifact

  artifact ─► assertReplayArtifactShape ─► ok?
                                          │ no → throw "not promotable:\n - <path>: <msg>"
                                          │ yes → proceed to freeze
```

**Step 3 — promote (freeze).** `promote-replay-to-fixture.mjs` is the load-bearing
step. It re-asserts the artifact, then *transforms* it into a fixture: it reads the
source fixture, swaps in a single `modelResponse` built from the artifact's final
recommendations (stripped of ids, ASCII-normalized), records the token totals as
`estimated`, and writes a timestamped, slugified file under `fixtures/promoted/`.

```
  promote transform — artifact → frozen fixture

  source fixture (workspace, tools, anomaly...)
        +  modelResponses: [ one text turn = artifact.recommendations as JSON ]
        +  promotion: { sourceArtifact, sourceProvider, promotedAt, note }
        =  fixtures/promoted/<slug>-<timestamp>.json
                                    │
   note says: "captures the final replay answer deterministically; it does NOT
   reconstruct the live provider tool loop" ← the honest limitation, in the file
```

The boundary worth naming: the promoted fixture collapses a multi-turn live run into
a *single* recorded final answer. It replays the *conclusion*, not the tool-calling
journey. So `replay:promoted` regression-tests "does the agent still produce this
blessed output shape + behavior," not "does the agent still take the same tool path."
That's a deliberate scope cut, written into the fixture's `note` field.

**Step 4 — replay the baseline.** `replay:promoted` (via
`replay-promoted-fixtures.mjs`) lists every `fixtures/promoted/*.json`, runs each
through the agent's `runFixtureReplay`, and checks both the structural `eval.ok` and
the domain `behavior.ok` (required text / required features). It exits non-zero on
any failure — a real regression gate. If the directory is empty it reports a clean
`{ ok: true, checked: 0, message }` and exits 0.

### Move 3 — the principle

When the "expected" value is too expensive or non-deterministic to write by hand,
generate it once under review and freeze it. The discipline that makes it safe is
the gate: never promote an unreviewed or malformed capture, and never hand-edit a
promoted baseline (editing it silently changes what "correct" means).

## Primary diagram

```
  Promote-to-fixture — full lifecycle with the gate

  replay:model ──► artifacts/replays/X.json ──► eval:replays
   (live, tokens)        (gitignored)            │ shape+secret gate
                                                 ▼
                                          human review
                                                 │
                              promote:replay ─────┘
                                    │ assertReplayArtifactShape (re-gate)
                                    │ strip ids, ASCII-normalize, 1 turn
                                    ▼
                          fixtures/promoted/X-<ts>.json (committed, frozen)
                                    │
                              replay:promoted
                                    │ runFixtureReplay each
                                    ▼
                          eval.ok && behavior.ok ? exit 0 : exit 1
```

## Implementation in codebase

**Use cases:**
1. Locking a good model run as a regression baseline after manual review.
2. Re-baselining when you intentionally accept a new model behavior (delete old
   promoted fixture, capture + promote a new one).
3. The recommendation agent runs its promoted baseline *inside* `npm test` —
   uniquely among the agents.

**Code side by side — the gate** (`scripts/promote-replay-to-fixture.mjs`):

```
  scripts/promote-replay-to-fixture.mjs  (lines 33–37)

  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  const artifactEval = assertReplayArtifactShape(artifact);   ← re-gate at promote time
  if (!artifactEval.ok) {
    throw new Error(`replay artifact is not promotable:\n${
      artifactEval.issues.map(formatIssue).join('\n')}`);     ← refuse, list every path
  }
        │
        └─ promotion CANNOT happen on a malformed/leaky artifact — the freeze step
           re-runs the same shape+secret assertion eval:replays uses (load-bearing)
```

**Code side by side — the honest limitation, written into the fixture**
(`scripts/promote-replay-to-fixture.mjs`):

```
  scripts/promote-replay-to-fixture.mjs  (lines 68–73)

  promotion: {
    sourceArtifact: relativeFromRoot(artifactPath),
    sourceProvider: artifact.provider,
    promotedAt: new Date().toISOString(),
    note: 'This fixture captures the final replay answer deterministically; '
        + 'it does not reconstruct the live provider tool loop.',   ← scope cut, in-file
  }
```

**Code side by side — the regression gate** (`scripts/replay-promoted-fixtures.mjs`):

```
  scripts/replay-promoted-fixtures.mjs  (lines 28–47)

  for (const fixturePath of fixturePaths) {
    const result = await runFixtureReplay(fixturePath);
    results.push({
      ok: result.eval.ok && result.behavior.ok,   ← shape AND domain behavior
      issues: [...result.eval.issues, ...result.behavior.issues],
      [countField]: outputCount(result, countField),
    });
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) process.exitCode = 1;     ← non-zero = CI-ready gate
```

## Elaborate

Golden-master / characterization testing comes from working with legacy code you
don't fully understand: you capture current behavior as the "expected" so any future
change that alters it shows up red. AptKit applies it to an LLM, where you don't
fully understand the output *by nature*, not by legacy. The LLM-specific adaptations:
(1) an eval gate before freezing, because the capture itself might be wrong or leak a
key; (2) ASCII normalization (`asciiString`, line 105) because models emit smart
quotes and em-dashes that would make the frozen fixture noisy; (3) collapsing the
multi-turn run to a single recorded answer, trading tool-path fidelity for a stable
baseline.

The gap the audit flags: `rubric-improvement` has no promote lifecycle wired in — no
`replay:fixture`, no `replay:promoted`, no promoted fixture. The agent whose job is
quality judgment has no quality-regression baseline. And no CI runs *any* of these —
`eval:replays` and `replay:promoted` are local-only (`audit.md` lens 7).

## Interview defense

**Q: How do you regression-test an LLM agent when you can't write the expected output
by hand?**
> Golden master. Run the live model once, eval the capture for shape and leaked
> secrets, then freeze a reviewed one as a committed baseline. After that, "correct"
> means "matches the blessed run," replayed deterministically with zero tokens.

```
  live run ─eval gate─► reviewed ─freeze─► baseline ─replay:promoted─► red/green
```
> Anchor: the expensive output becomes the expected output — but only after a gate.

**Q: What's the limitation of your promoted fixtures?**
> They capture the *final answer*, not the tool-calling path — the fixture's own
> `note` field says so. So `replay:promoted` catches "the agent's conclusion
> regressed," not "the agent's tool sequence changed." Deliberate scope cut for a
> stable baseline.

## Validate

1. **Reconstruct:** draw the lifecycle — live → artifact → eval gate → promote →
   replay:promoted — and name what each storage zone's trust level is.
2. **Explain:** why does `promote-replay-to-fixture.mjs:34` re-run the shape
   assertion when `eval:replays` already ran it earlier?
3. **Apply:** you want to accept a new, better recommendation the model now produces.
   What's the safe sequence? (Capture via `replay:openai`, eval, review, delete the
   stale promoted fixture, `promote:replay` the new artifact.)
4. **Defend:** the project context says promoted fixtures must not be hand-edited.
   Why does editing one silently break the suite's meaning?

## See also

- `01-replay-as-test.md` — the replay engine the baseline runs on.
- `02-structural-shape-assertions.md` — the gate assertion (`assertReplayArtifactShape`).
- `study-data-modeling` — the artifact + fixture schema as a data model.
- `study-ai-engineering` — the eval discipline behind the gate.
- `audit.md` lens 7 — the rubric-improvement gap and the missing CI gate.
