# fixture promotion lifecycle

**Industry name(s):** golden-file / snapshot promotion; data-lifecycle versioning; recorded-baseline pattern. **Type label:** Project-specific pattern (the AptKit data lifecycle), built on the industry-standard golden-file idea.

## Zoom out, then zoom in

You know how a snapshot test records a "known good" output and then fails if future runs diverge? AptKit takes that one step further: a *live* model run gets recorded as an artifact, reviewed, and then *promoted* into a deterministic fixture that becomes a correctness baseline. It's a data lifecycle — the same fact (an agent's output) moves through three storage forms, each with a different role.

```
  Zoom out — where promotion sits in the data lifecycle

  ┌─ LIVE run (provider: openai/anthropic) ─────────────┐
  │  agent loop → real model → output + trace           │
  └───────────────────────────┬─────────────────────────┘
                              │  recorded as
  ┌─ ARTIFACT (artifacts/replays/*.json) ──────────────▼┐
  │  schemaVersion:1, output, trace, eval   (ephemeral)  │
  └───────────────────────────┬─────────────────────────┘
                              │  ★ PROMOTE ★ (the move)
  ┌─ PROMOTED FIXTURE (fixtures/promoted/*.json) ──────▼┐
  │  recorded ModelResponse[] + provenance  (baseline)   │ ← we are here
  └───────────────────────────┬─────────────────────────┘
                              │  replayed deterministically by
  ┌─ FixtureModelProvider ─────────────────────────────▼┐
  │  returns recorded responses in order — no network    │
  └───────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **a data-lifecycle promotion** — a recorded run graduates from a disposable artifact into a versioned, timestamped, provenance-stamped baseline. The question it answers: how do you turn an expensive, non-deterministic live result into a cheap, deterministic, trustworthy test input — and keep a record of where it came from?

## Structure pass

**Layers.** Three storage forms of the same fact: the *artifact* (ephemeral, regenerable), the *promoted fixture* (durable baseline), and the *FixtureModelProvider* (the consumer that replays it). Promotion is the transform between the first two.

**Axis — trace "is this data trusted / authoritative?":**

```
  axis: "how much do we trust this copy?"

  artifact            seam: promotion       promoted fixture
  ┌────────────────┐  ═══════╪════════════► ┌──────────────────┐
  │ disposable     │   (trust flips: from   │ correctness       │
  │ regenerable    │    "a run happened" to  │ BASELINE          │
  │ not a baseline │    "this is the answer  │ editing it changes│
  └────────────────┘    we vouch for")       │ test meaning      │
                                             └──────────────────┘
```

**Seam.** Promotion is the load-bearing joint, and the axis that flips across it is *authority*. Before promotion, an artifact is just "a thing that happened" — disposable. After promotion, the fixture is a thing the test suite *vouches for*: per the project constraints, promoted fixtures are correctness baselines and are not hand-edited, only regenerated. The promotion step is where data crosses from "observed" to "trusted."

## How it works

### Move 1 — the mental model

Promotion is a controlled copy with a transform and a paper trail. It's the same shape as accepting a Jest snapshot (`--updateSnapshot`), but with provenance recorded so you can always trace a baseline back to the run that produced it.

```
  The pattern — record → validate → transform → stamp provenance

  artifact ──validate (must pass shape eval)──► transform (extract output,
                                                  re-shape as ModelResponse[])
                                                       │
                                                       ▼
                                          promoted fixture
                                          + promotion: { sourceArtifact,
                                                         sourceProvider,
                                                         promotedAt, note }
```

The kernel: validate-before-promote + provenance-on-promote. Strip the validation and you'd promote a malformed artifact into a baseline (poisoning the test suite). Strip the provenance and you'd have a baseline you can't trace back to its origin (an un-auditable golden file).

### Move 2 — the walkthrough

**Step 1 — validate the artifact before trusting it.** Promotion refuses to run on an artifact that doesn't pass the shape eval. Bridge: it's a `CHECK` constraint enforced at the moment of promotion — you can't promote garbage. This is the gate that protects the baseline's integrity.

```
  validate-before-promote (execution trace)

  artifact = JSON.parse(file)
  artifactEval = assertReplayArtifactShape(artifact)
    if (!artifactEval.ok) → throw "replay artifact is not promotable"
       │
       └─ the artifact must have valid schemaVersion, required paths,
          a passing embedded eval, AND no secret-like strings
          (see 05-structural-diff-integrity.md) before it can become
          a baseline
```

**Step 2 — start from the source fixture, not from scratch.** The promoted fixture is built by spreading the *original* fixture (`...sourceFixture`) and overriding only what changed. Bridge: it's an immutable update — copy the old record, replace the fields that differ. This keeps the workspace, tools, and expectations intact while swapping in the recorded output.

**Step 3 — transform the output into recorded `ModelResponse[]`.** The artifact's structured output (e.g. `recommendations[]`) is wrapped back into the `ModelResponse` shape the provider would have returned — a single text block containing the JSON.

```
  the re-shape — output back into a ModelResponse

  artifact.recommendations  ──strip ids──► JSON string
                                              │
                                              ▼
  modelResponses: [ { content: [{ type:'text', text: '```json...```' }],
                      usage: { ...summed from trace... },
                      model: 'promoted-<provider>-replay' } ]
       │
       └─ note: this captures the FINAL answer, not the live tool loop.
          The promoted fixture is one deterministic response, not a
          replay of every turn (promotion note says so explicitly)
```

This is the lossy part, and it's deliberate: the promoted fixture replays the *answer*, collapsing a multi-turn live run into a single recorded response. The `note` field documents exactly this so a future reader isn't surprised.

**Step 4 — normalize for portability.** `toAscii` strips smart quotes, em-dashes, and any non-ASCII byte from the recorded text. Bridge: it's data cleaning at the storage boundary — the baseline must be a clean, diff-stable ASCII string so it survives git and cross-platform reads without encoding surprises.

**Step 5 — stamp provenance.** The promoted fixture gets a `promotion` block: `sourceArtifact` (the file it came from), `sourceProvider` (which model produced it), `promotedAt` (when), and a `note`. This is the audit trail — the thing that makes a golden file traceable rather than mysterious.

**Step 6 — name with a timestamp.** The output filename is `<slug>-<artifact-timestamp>.json`. Bridge: the filename *is* the version key. Promote the same fixture twice and you get two timestamped files side by side (you can see this in the recommendation fixtures — two `voucher-dropoff-w10-on-openai-promoted-*` files with different timestamps). The directory becomes an append-only history of baselines.

### Move 3 — the principle

Promotion is how you convert a non-deterministic, expensive observation into a deterministic, cheap, trusted input — without losing the chain of custody. The validation gate protects the baseline's integrity; the provenance block protects its auditability; the timestamp gives it a version. **A recorded baseline you can't trace back to its source is technical debt; promotion's discipline is that every baseline carries its own origin story.**

## Primary diagram

The full lifecycle, from live run to deterministic replay, with the validation gate and provenance marked.

```
  Fixture promotion — the full data lifecycle

  LIVE                ARTIFACT              PROMOTION              FIXTURE
  ────                ────────              ─────────              ───────
  ┌──────────┐  rec   ┌──────────────┐  ✓gate ┌──────────────┐    ┌──────────────┐
  │ real     │ ─────► │ schemaVersion│ ─validate► │ spread source │ ─► │ ModelResponse[]│
  │ model run│        │ output,trace │  ✓shape │ + re-shape    │    │ + promotion:  │
  │ (openai) │        │ (disposable) │  ✓no    │ + toAscii     │    │   sourceArtifact│
  └──────────┘        └──────────────┘  secret │ + provenance  │    │   promotedAt   │
                                               └──────────────┘    └──────┬───────┘
                                                                          │ replayed by
                                                                   ┌──────▼────────┐
                                                                   │FixtureModel-  │
                                                                   │Provider (no   │
                                                                   │ network)      │
                                                                   └───────────────┘
```

## Implementation in codebase

**Use cases in AptKit.** When a live run against OpenAI or Anthropic produces a good result, you promote its artifact into a fixture so the result becomes a deterministic test baseline — replayable in CI with no API key and no cost. The recommendation, monitoring, diagnostic, and query agents all have `fixtures/promoted/` directories holding these baselines. It's the back half of the replay-centric evaluation loop (`live run → artifact → eval → promote → deterministic replay`).

**The promotion script, line by line** — `scripts/promote-replay-to-fixture.mjs`:

```
  :34-37   validate-before-promote
    const artifactEval = assertReplayArtifactShape(artifact);
    if (!artifactEval.ok) throw new Error('replay artifact is not promotable...');
         │
         └─ the integrity gate — a malformed artifact never becomes a baseline

  :44-67   build the promoted fixture
    const promoted = {
      ...sourceFixture,                ← immutable update: keep workspace/tools
      id: promotedId,
      modelResponses: [{ content: [{ type:'text',
        text: JSON.stringify(toAscii(stripRecommendationIds(...))) }],
        usage: modelUsageTotals(artifact.trace),   ← summed from the trace
        model: `promoted-${providerId}-replay` }],
      promotion: { sourceArtifact, sourceProvider, promotedAt, note }  ← provenance
    };

  :78      timestamped filename = the version key
    `${slugify(promotedId)}-${formatDateForFilename(artifactTimestamp)}.json`

  :89-94   stripRecommendationIds — drop run-specific ids
         │
         └─ the per-run ids (e.g. "sp-revenue-drop-w4-studio-1") are noise in a
            baseline; stripping them keeps the fixture about content, not run id
```

**The consumer** — `packages/agents/query/src/fixture-provider.ts:3-18`. `FixtureModelProvider` implements `ModelProvider` by returning the recorded `modelResponses` in order:

```
  fixture-provider.ts:11-17
    async complete(request) {
      this.requests.push(request);
      const response = this.responses[this.index];
      this.index += 1;
      if (!response) throw new Error(`fixture model exhausted after ...`);
      return response;
    }
         │
         └─ deterministic replay: same recorded responses, same order, no
            network. This is what makes the promoted baseline a runnable test
```

**A real promoted baseline** — `packages/agents/query/fixtures/promoted/revenue-by-state-query-fixture-promoted-2026-06-18-19-29-11.json:103-137`. It holds one `modelResponses` entry (the collapsed final answer, `model: "promoted-fixture-replay"`) and a `promotion` block (lines 129-137) recording `sourceArtifact`, `promotedAt: "2026-06-18T19:37:13.692Z"`, and the note: *"captures the final query replay answer deterministically; it does not reconstruct the live provider tool loop."* That note is the chain-of-custody honesty in action.

## Elaborate

This is the golden-file / approval-test pattern (Jest snapshots, ApprovalTests, VCR-style HTTP cassettes) applied to LLM outputs, with the addition of an explicit promotion *step* and *provenance*. The reason it needs the extra ceremony: LLM outputs are non-deterministic and expensive, so you can't re-derive them in CI — you have to record them. And because a recorded LLM answer is being trusted as "correct," you want to know which model produced it and when, hence the provenance block.

Where it connects: promotion runs only on a `schemaVersion`-gated, shape-valid artifact (`03-versioned-artifact-schema.md`, `05-structural-diff-integrity.md`). It reads the typed artifact (`01`, `02`) and writes a new fixture that's the input side of the next run. The whole thing is the data half of the testing loop — `study-testing` owns the *eval* semantics; this file owns the *data lifecycle* the eval runs on.

## Interview defense

**Q: Walk me through AptKit's data lifecycle for an agent output.**
"Three forms. A live run produces an artifact (`artifacts/replays/*.json`) — disposable, regenerable. If the result is good, `promote-replay-to-fixture.mjs` validates it against the shape eval, then transforms it into a promoted fixture (`fixtures/promoted/*.json`) — a correctness baseline with provenance. The baseline is replayed deterministically by `FixtureModelProvider`, which just returns the recorded responses in order, no network. The same fact moves observed → trusted → replayed."

```
  live run ─► artifact (disposable) ─promote─► fixture (baseline) ─► replay
                            ✓validate    +provenance     deterministic
```

Anchor: *promotion is where data crosses from observed to trusted.*

**Q: What stops a bad output from becoming a baseline?**
"The validation gate at `promote-replay-to-fixture.mjs:34-37` — `assertReplayArtifactShape` must pass, or promotion throws. That means valid `schemaVersion`, all required paths, a passing embedded eval, and no secret-like strings. A malformed artifact physically cannot become a fixture."

Anchor: *validate-before-promote — the integrity gate protects the baseline.*

**Q: The part people forget?**
"Provenance. Anyone can copy an output into a fixture file. The discipline that matters is the `promotion` block — `sourceArtifact`, `sourceProvider`, `promotedAt`, and a `note` saying it captures the final answer, not the live tool loop. Without that, a golden file is a mystery value nobody dares change. With it, you can trace any baseline back to the exact run that produced it. The timestamp in the filename also makes the promoted directory an append-only version history."

## Validate

1. **Reconstruct.** Name the three storage forms in the lifecycle and which is the trusted baseline. (artifact → promoted fixture [baseline] → replayed by FixtureModelProvider.)
2. **Explain.** Why does the promoted fixture collapse a multi-turn run into a single `ModelResponse`? (It captures the final answer deterministically; the `note` field at the promoted JSON's `promotion.note` documents that it doesn't reconstruct the tool loop.)
3. **Apply.** You promote the same fixture twice. What happens on disk, and why is that the right behavior? (Two timestamped files coexist — `voucher-dropoff-w10-on-openai-promoted-*` shows exactly this — giving an append-only baseline history.)
4. **Defend.** Justify the `assertReplayArtifactShape` gate at `promote-replay-to-fixture.mjs:34`. State the failure mode without it (a malformed or secret-bearing artifact becomes a trusted CI baseline).

## See also

- `03-versioned-artifact-schema.md` — promotion runs only on a version-gated artifact.
- `05-structural-diff-integrity.md` — the shape eval that gates promotion (the `CHECK` analog).
- `01-type-as-schema.md` / `02-tagged-union-event-log.md` — the artifact shape promotion reads.
- `audit.md` — Lens 5 (evolution / data lifecycle), Lens 4 (integrity gate).
- `study-testing` — the eval semantics that consume these baselines (the testing view of the same loop).
