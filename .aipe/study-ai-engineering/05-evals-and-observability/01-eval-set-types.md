# Eval set types

**Subtitle:** Golden / adversarial / regression sets · promoted fixtures as the golden+regression set · *Industry standard (golden/regression strong; adversarial `not yet exercised`)*

## Zoom out, then zoom in

Before you pick a scoring method, you pick the *set* you're scoring against. The
field names three, and they answer three different questions: golden ("is the
right answer still right?"), adversarial ("can a hostile input break it?"), and
regression ("did the bug I already fixed come back?"). aptkit has a strong story
for two of them and an honest gap on the third.

```
  Zoom out — the three eval sets and where aptkit stands

  ┌─ Golden set ─────────────────────────────────────────────┐
  │  ★ hand-curated right answers ★                           │ ← promoted fixtures
  │  packages/agents/*/fixtures/promoted/*.json               │   ARE this
  └───────────────────────────────────────────────────────────┘
  ┌─ Regression set ─────────────────────────────────────────┐
  │  ★ frozen past failures ★                                 │ ← the hallucinated-
  │  a fixed bug, locked as a test                            │   filter bug shape
  └───────────────────────────────────────────────────────────┘
  ┌─ Adversarial set ────────────────────────────────────────┐
  │  hostile / out-of-distribution inputs                     │ ← not yet exercised
  │  (no adversarial fixture dir in the repo)                 │   (honest gap)
  └───────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting move in aptkit is that golden and regression aren't
two separate corpora you maintain by hand. They're the *same* directory of
promoted fixtures, and it grows one entry at a time as you catch failures. A
promoted fixture starts life as "here is a correct trajectory" (golden) and the
moment a refactor would change it, it becomes "and it must not regress"
(regression). One artifact, two jobs.

## Structure pass

**Layers.** Live run (real provider) → replay artifact (`artifacts/replays/*.json`)
→ promotion (`scripts/promote-replay-to-fixture.mjs`) → promoted fixture
(`packages/agents/*/fixtures/promoted/*.json`) → deterministic replay in the
package's test.

**Axis — trust.** Trace where you're *allowed to trust* a recorded answer. A raw
replay artifact is untrusted until `assertReplayArtifactShape` passes
(`promote-replay-to-fixture.mjs:34`). Once promoted, the fixture is the trusted
baseline — every later run is compared *to it*, not re-judged. Trust flips at the
promotion step: before it, the artifact is a candidate; after it, it's the
ground truth a regression is measured against.

**Seam.** The promotion script (`scripts/promote-replay-to-fixture.mjs`). On one
side, a disposable artifact from a live run; on the other, a timestamped fixture
checked into git that tests replay forever. That seam is where "an answer the
model gave once" becomes "the answer it must keep giving."

## How it works

### Move 1 — the mental model

A promoted fixture is a **snapshot test for an agent run**. You know how a
snapshot test captures a component's rendered output, commits it, and fails the
build when the output drifts? Same idea — except the "output" is a full agent
trajectory (question → tool calls → answer), and the "render" is a model run. The
first capture is the golden answer; every later run is diffed against it; an
unexpected diff is a regression.

```
  Snapshot test  ─analogy─►  promoted fixture

  render component   ─►   run agent against fixture inputs
  snapshot the HTML  ─►   record ModelResponse[] + answer
  commit the .snap   ─►   commit fixtures/promoted/*.json
  diff on next run   ─►   replay deterministically, compare
  unexpected diff    ─►   regression caught
```

The one rule snapshot tests teach you carries over exactly: **you do not
hand-edit the snapshot.** If you edit it to make the test pass, you've changed
what "correct" means and the test now proves nothing.

### Move 2 — the three sets, concretely

**The golden set — promoted fixtures are recorded correct trajectories.** A
promoted fixture is the source fixture plus a recorded final answer, frozen with
provenance. The promotion script copies the source fixture, attaches the live
answer as a `modelResponses` entry, and stamps where it came from
(`promote-replay-to-fixture.mjs:44`):

```js
const promoted = {
  ...sourceFixture,
  id: promotedId,
  modelResponses: [ /* the recorded answer, ascii-normalized */ ],
  promotion: {
    sourceArtifact: relativeFromRoot(artifactPath),
    sourceProvider: artifact.provider,        // openai / fixture / gemma — provenance
    promotedAt: new Date().toISOString(),     // TIMESTAMPED, auto-generated
    note: 'captures the final replay answer deterministically; does not reconstruct the live tool loop.',
  },
};
```

The filename itself is timestamped (`promote-replay-to-fixture.mjs:78`,
`${slugify(promotedId)}-${formatDateForFilename(...)}.json`) — e.g.
`voucher-dropoff-w10-on-openai-promoted-2026-06-18-16-53-02.json`. That timestamp
is the tell that **this file is auto-generated, not hand-authored.** Editing it
changes the meaning of the test; you regenerate it via `npm run promote:replay`
instead.

```
  Golden — one promotion, frozen with provenance

  live OpenAI run ─► artifact ─► promote ─► fixtures/promoted/
       │                                       │ id + modelResponses + promotion{}
       ▼                                       ▼ timestamped filename
  "the model said X once"             "X is now the correct answer; do not edit"
```

**The regression set — a fixed bug, frozen as a test.** A regression case is just
a golden fixture whose *origin* is a bug. The repo's signature bug — the
hallucinated metadata filter that silently returned zero results — is exactly
this shape: you reproduce the failure, fix it, then freeze the fixed behavior so a
refactor can't reintroduce it. The promoted-fixtures dir grows one such case at a
time, every time you catch a real failure. (The bug itself lives in
`04-agents-and-tool-use/06-error-recovery.md`.)

```
  Regression — a caught failure becomes a permanent guard

  bug found in prod ─► reproduce ─► fix ─► record correct run ─► promote
                                                                    │
                                                                    ▼
                            fixtures/promoted/ grows by one; the bug can't return
```

**The adversarial set — `not yet exercised`.** There is no adversarial fixture
directory in aptkit. An adversarial set would be hostile or out-of-distribution
inputs — prompt-injection in retrieved chunks, a metric name that doesn't exist,
a deliberately malformed question — curated to *try to break* the agent. aptkit
hardened against specific adversarial inputs in code (the hallucinated-filter
guard, the `minTopK` floor) but never froze a dedicated adversarial *set*. Saying
this plainly is the move: "golden and regression are strong via promoted
fixtures; adversarial is the gap, and here's where it would live."

```
  Adversarial — the missing set (where it would go)

  packages/agents/query/fixtures/adversarial/   ← does not exist
     hostile-question-injection.json            ← would test prompt injection
     nonexistent-metric.json                    ← would test bad tool args
                                                   not yet exercised
```

### Move 3 — the principle

Don't curate eval sets up front; *grow* them from real runs. Every promoted
fixture is a correct trajectory you actually observed, frozen so it can never
silently change. That makes the golden set and the regression set the same
artifact viewed at two moments — "this is right" and "this must not break." The
discipline that makes it work is the snapshot rule: the fixture is
auto-generated, never hand-edited, so a green test always means "still matches the
recorded truth" rather than "matches whatever I last typed."

## Primary diagram

```
  Eval sets in aptkit — one pipeline, three jobs

  live run (openai/gemma) ──► artifact ──► assertReplayArtifactShape ──► promote
                                                  │ gate                     │
                                                  ▼                          ▼
                                          (untrusted → trusted)   fixtures/promoted/*.json
                                                                      │  timestamped, ascii,
                                                                      │  do-not-hand-edit
                  ┌───────────────────────────────────────────────────┘
                  ▼
  ┌─ GOLDEN ─────────────┐  ┌─ REGRESSION ─────────────┐  ┌─ ADVERSARIAL ────────┐
  │ recorded correct     │  │ a frozen past failure    │  │ hostile inputs       │
  │ trajectory           │  │ (same file, bug origin)  │  │ NOT YET EXERCISED    │
  └──────────────────────┘  └──────────────────────────┘  └──────────────────────┘
        deterministic replay in `npm test` per package (node --test)
```

## Elaborate

Most teams treat the golden set as a hand-maintained spreadsheet of (input,
expected) pairs and let it rot. aptkit's version is better in one specific way: the
golden answer is captured from a real run with full provenance (which provider,
which artifact, when), so you always know *how* the baseline was produced. The
trade-off is that a promoted fixture captures the *final answer* deterministically
but does not reconstruct the live tool loop (the `promotion.note` says so
literally) — so it proves "the agent still produces this answer," not "the agent
still takes these tool steps." That's the right call for a correctness baseline
and worth saying out loud. buffr carries the same idea at smaller scale: a 3-doc
relevance set in `/Users/rein/Public/buffr/eval/queries.json` (`[{query,
relevant:["work.md"]}]`) graded with precision@k — a hand-curated golden set for
retrieval. Read `02-eval-methods.md` for how each set gets scored, and
`04-agents-and-tool-use/06-error-recovery.md` for the bug that defines the
regression shape.

## Project exercises

### Add an adversarial fixture set for the query agent
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a `fixtures/adversarial/` directory for the query agent with
  cases designed to break it — a question that names a nonexistent metric, a
  question with prompt-injection text in the workspace data — plus a test that
  asserts the agent degrades gracefully (refuses or says "no data") instead of
  hallucinating.
- **Why it earns its place:** adversarial is the one named eval set aptkit lacks;
  building it closes the most visible gap and shows you understand that "right
  answer" and "doesn't break under attack" are different tests.
- **Files to touch:** `packages/agents/query/fixtures/`,
  `packages/agents/query/test/`, reading
  `packages/agents/query/src/fixture-provider.ts`.
- **Done when:** an adversarial fixture replays to a safe refusal, and the test
  fails if the agent instead emits a confident hallucinated answer.
- **Estimated effort:** `1–4hr`

### Wire `replay:promoted` into the rubric-improvement agent
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** add a `replay:promoted` script to
  `packages/agents/rubric-improvement/package.json` and call it from that
  package's `test`, mirroring the four agents that already do (recommendation,
  query, monitoring, diagnostic).
- **Why it earns its place:** rubric-improvement is the one agent whose promoted
  fixtures aren't guarded in the root pipeline — an inconsistency a reviewer will
  spot; fixing it makes the backbone uniform.
- **Files to touch:** `packages/agents/rubric-improvement/package.json`, reading
  `scripts/replay-promoted-fixtures.mjs` and
  `packages/agents/recommendation/package.json` as the template.
- **Done when:** `npm test -w @aptkit/agent-rubric-improvement` replays any
  promoted fixture and fails on a mismatch.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "How do you build and maintain your golden eval set?"**
I don't hand-author it — I grow it from real runs. A live run records a replay
artifact; I gate it through `assertReplayArtifactShape`, then promote it into a
timestamped fixture under `fixtures/promoted/`. From then on the agent's tests
replay it deterministically. The same fixture is both my golden set (the recorded
correct answer) and my regression set (it must not change), and it's
auto-generated so I never hand-edit it — a green test always means "still matches
recorded truth."

```
  real run → artifact → gate → promote → fixtures/promoted/ → deterministic replay
  golden answer AND regression guard = the same file, never hand-edited
```
Anchor: *grow the golden set from real runs; the snapshot rule is "don't edit the snapshot."*

**Q: "What kind of eval set are you missing, and why does it matter?"**
Adversarial. I have strong golden and regression coverage through promoted
fixtures, but no dedicated adversarial set — no fixture dir of hostile or
out-of-distribution inputs. I hardened against specific adversarial cases in code
(the hallucinated-filter guard, the `minTopK` floor), but I never froze them as a
set. It matters because golden tests prove the right answer stays right; they say
nothing about behavior under attack. That's the next set I'd build.

```
  golden ✓   regression ✓   adversarial ✗ (not yet exercised)
  hardened in code, never frozen as a set
```
Anchor: *name the gap before they do — adversarial is the missing set.*

## See also

- `02-eval-methods.md` — how each set gets scored (the cheap→expensive ladder)
- `04-llm-observability.md` — the replay artifact this all rides on
- `04-agents-and-tool-use/06-error-recovery.md` — the bug that defines the regression shape
- `01-llm-foundations/08-provider-abstraction.md` — the seam that makes `FixtureModelProvider` possible
