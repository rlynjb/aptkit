# Eval as embedded evidence

*Industry name(s): golden-file assertion / embedded test verdict / artifact-level
gating. Type label: Project-specific (the embedded `eval` block is AptKit's; the
shape-assertion idea is standard).*

## Zoom out, then zoom in

You know how a CI run doesn't just produce build output — it produces output *plus* a
pass/fail verdict stamped right next to it, so you never have to re-judge whether the
build was good? The `eval` block does that for every agent run: the verdict on whether
the output is well-formed travels *inside* the same artifact as the output and the trace.
Evidence and verdict, never separated.

```
  Zoom out — where the eval verdict lives

  ┌─ Studio UI layer ───────────────────────────────────────────┐
  │  EvalPanel: pass / fail + issue list   (components.tsx:182)  │
  └───────────────────────────────▲──────────────────────────────┘
                                   │  eval { ok, issues }
  ┌─ Persistence / eval layer ──────────────────────────────────┐
  │  ★ artifact.eval ★  +  assertions.ts (shape + secret-scan)   │ ← we are here
  │  CLI: eval:replays scans every artifact (replay-runner.ts)   │
  └───────────────────────────────▲──────────────────────────────┘
                                   │  computed at run time
  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  runReplay → validate output → eval{ok,issues}               │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **stamp a structured pass/fail verdict onto the run's own
artifact, and re-check it on every read.** Two layers of check: the output *shape* (is
this valid?) and a *secret-scan* (is this safe to share?). The question it answers: *is
this run's output correct and safe — and can I trust that without re-deriving it?*

## The structure pass

**Layers.** The *run-time* check (validate the live output, embed `eval`), and the
*read-time* check (re-assert the saved artifact's whole shape, including the secret-scan).

**One axis — "is the verdict trustworthy?"** Trace it:

```
  axis = "do I trust this run's correctness, and when was it judged?"

  ┌─ live output ───────────────┐  unjudged — just data
  └──────────────┬──────────────┘
                 │  seam: validate*() at run time → embed eval{ok,issues}
  ┌─ artifact.eval ─────────────┐  judged AT run time, verdict travels with the data
  └──────────────┬──────────────┘
                 │  seam: assertCapabilityReplayArtifactShape() at read time
  ┌─ re-verified artifact ──────┐  re-judged + secret-scanned ON EVERY READ
  └─────────────────────────────┘
```

**Two load-bearing seams.** The first — validate-and-embed at run time — means the verdict
is computed once, against the live output, and frozen. The second — re-assert at read time
— means the CLI and Studio *don't trust the embedded `eval` blindly*; they re-run the shape
assertion (which itself requires `eval.ok === true`) and the secret-scan. So the verdict is
both recorded *and* re-verifiable, and a tampered or stale artifact fails the read-time
check.

## How it works

### Move 1 — the mental model

When a run finishes, validate its output against a shape assertion and write
`{ name, ok, issues }` into the artifact. When anything reads the artifact later, re-run a
broader assertion that requires `eval.ok` to be true *and* scans the whole artifact for
secret-like strings.

```
  The pattern — judge once, embed, re-verify on read

  run finishes ──► validate(output) ──► eval { name, ok, issues }  (embedded)
                                              │
  later read ──► assertReplayArtifactShape(artifact)
                     ├─ required keys present?
                     ├─ trace is an array?
                     ├─ eval.ok === true?         ← re-checks the embedded verdict
                     └─ findSecretLikeString?     ← safety gate
                     → ok / issues
```

### Move 2 — the walkthrough

**Run-time validation — `validate*` + embed.** Each `runReplay` variant validates its
output with the capability's validator (`validateAnomalies`, `validateDiagnosis`,
`validateQueryAnswer`, or `assertRecommendationShape`) and embeds the result as
`eval: { name, ok, issues }`. Bridge: an assertion at the end of a test that records its
own result instead of throwing. What breaks without it: the artifact records *what came
out* but not *whether it's valid* — every consumer would have to re-judge.

```
  Run-time embed — validate, then stamp the verdict

  anomalies = await agent.scan()
  validation = validateAnomalies(anomalies)          ← shape check on the output
  issues = validation.ok ? [] : [{ path:'anomalies', message: validation.error }]
  return { ..., eval: { name:'anomaly-shape', ok: validation.ok, issues }, ... }
                              │
                      the verdict, frozen into the artifact next to the data it judges
```

**Read-time shape assertion — `assertCapabilityReplayArtifactShape`.** The CLI eval and
Studio's replay list call this on the parsed artifact. It checks required keys, that
`trace` is an array, that the embedded `eval.ok` is `true`, validates the optional
prompt-package provenance, and runs the secret-scan. Bridge: a schema validation at a trust
boundary — you're reading a file off disk, you don't trust it. What breaks without it: a
hand-edited or corrupt artifact (or one whose embedded `eval` was forged to `true`) would
be accepted; re-asserting the *whole* shape catches structural drift the embedded verdict
alone can't.

**The secret-scan — `findSecretLikeString`.** It walks the artifact recursively and flags
any string matching `sk-[A-Za-z0-9_-]{10,}` (OpenAI-style keys) or `OPENAI_API_KEY=`. If it
finds one, the artifact fails its eval. Bridge: a pre-commit secret scanner, but it runs at
artifact-eval time. What breaks without it: an artifact — which embeds full tool args,
results, and model output — could carry a leaked key, and these files get shared and
promoted. The project context flags `.env` as gitignored secrets; this scan is the
last-line guard that a secret didn't end up *inside* an artifact. The posture is
**detect-and-refuse**, not redact: a flagged artifact isn't sanitized, it's marked invalid.

```
  Secret-scan — recursive, detect-and-refuse

  walk(artifact):
    string?  → matches /sk-.../  or /OPENAI_API_KEY=/ ? → issue{ path, "secret-like" }
    array?   → walk each element (path.index)
    object?  → walk each value  (path.key)
  any hit → eval fails → artifact not promotable, CLI exits non-zero
```

**The aggregate report — `evaluateReplayArtifactFiles`.** The CLI folds per-artifact
results into `{ ok, checked, failed, results[] }` and sets a non-zero exit code if any
failed. Bridge: a test runner's summary line. This is what makes `npm run eval:replays` a
gate, not just a printout.

### Move 2 variant — the load-bearing skeleton

```
  the kernel:  validate-at-run → embed eval{ok,issues} → re-assert-at-read (+ secret-scan)
```

- **Drop the run-time embed** → the verdict isn't recorded; correctness must be re-judged
  every read, and a passing-then-broken regression has no recorded baseline.
- **Drop the read-time re-assertion** → you trust the embedded `eval` blindly; a corrupt or
  forged artifact passes.
- **Drop the secret-scan** → artifacts can carry leaked keys into shared/promoted files.
- **Drop the `eval.ok === true` requirement in the read assertion** → a run that *failed*
  its own shape check would still pass the artifact gate; the embedded verdict would be
  decorative.

**Skeleton vs hardening:** validate + embed + re-assert + secret-scan is the skeleton. The
prompt-package provenance check, the per-capability validator names, the aggregate exit
code, the ASCII-stripping on promotion — hardening.

### Move 3 — the principle

The principle is **the verdict is evidence, and evidence is re-verifiable.** Embedding the
`eval` makes correctness travel with the run, so debugging and regression-checking never
start from "is this even valid?" But the second move is what makes it trustworthy:
re-asserting at read time means the embedded verdict is a *cache*, not an *authority* — the
gate recomputes it. The secret-scan extends the same idea to safety: an artifact isn't
trusted to be shareable just because it was produced locally; it's scanned every time. For
a system whose artifacts are full of tool I/O and get promoted into the test suite, "judge
once, re-verify always" is the right discipline.

## Primary diagram

The whole eval lifecycle, run-time embed through read-time gate.

```
  Eval as embedded evidence — embed at run, re-verify at read

  ┌─ Runtime: runReplay ────────────────────────────────────────┐
  │ output = agent.run()                                         │
  │ validation = validate<Capability>(output)                    │
  │ eval = { name, ok: validation.ok, issues }  ── embedded ─────┼──┐
  └──────────────────────────────────────────────────────────────┘  │
                                                                      ▼
  ┌─ artifact.json ─────────────────────────────────────────────────────┐
  │ { output, trace[], eval{ok,issues}, ... }                            │
  └───────────────┬───────────────────────────────────┬──────────────────┘
                  │ Studio EvalPanel                    │ CLI eval:replays
                  ▼                                     ▼
  ┌─ display verdict ─────────┐   ┌─ assertCapabilityReplayArtifactShape (assertions.ts) ─┐
  │ pass / fail + issue list  │   │ keys? · trace array? · eval.ok===true? ·              │
  │ (components.tsx:182-207)  │   │ findSecretLikeString? (:397-411)                      │
  └───────────────────────────┘   │ → evaluateReplayArtifactFiles → exit 1 if any failed   │
                                   │   (replay-runner.ts:47-94)                            │
                                   └─────────────────────────────────────────────────────────┘
   The embedded eval is a recorded verdict; the read-time assertion RE-COMPUTES it +
   scans for secrets. The verdict is cached, never blindly trusted.
```

## Implementation in codebase

**Use cases in this repo.** Every `runReplay` embeds an `eval` (Studio shows it in
`EvalPanel`). `npm run eval:replays` gates every saved artifact through the shape +
secret check before you'd share or promote one. Promotion itself calls the stricter
`assertReplayArtifactShape` and refuses non-promotable artifacts
(`vite.config.ts:1308-1311`). This is the prevention half of the local "incident" loop in
the audit's lens 7.

**Run-time embed — `apps/studio/vite.config.ts:596-610` (monitoring):**

```
  runMonitoringReplay — validate the output, embed the verdict

  :596  const anomalies = await agent.scan();
  :597  const validation = validateAnomalies(anomalies);          ← shape check
  :598  const issues = validation.ok ? [] : [{ path:'anomalies', message: validation.error }];
  :606  eval: { name:'anomaly-shape', ok: validation.ok, issues },  ← verdict beside data
        │
        └─ same shape across all capabilities: recommendation, diagnostic, query each
           stamp their own { name, ok, issues } — one verdict format, many validators.
```

**Read-time re-assertion + secret-scan — `packages/evals/src/assertions.ts:355-365`
(query variant shown; all four variants do the same):**

```
  assertions.ts — re-verify the embedded verdict AND scan for secrets

  :355  const replayEval = output.eval;
  :356  if (!isRecord(replayEval) || replayEval.ok !== true)
  :357    issues.push({ path:'eval.ok', message:'expected embedded replay eval to pass' });
                              │
                              └─ the embedded verdict is RE-CHECKED, not trusted
  :360  validatePromptPackageProvenance(output, issues);   ← provenance integrity
  :362  const secretIssue = findSecretLikeString(output);  ← the safety gate
  :363  if (secretIssue) issues.push(secretIssue);
```

```
  findSecretLikeString — detect-and-refuse (assertions.ts:397-411)

  :398  if (typeof value === 'string') {
  :399    if (/sk-[A-Za-z0-9_-]{10,}/.test(value) || /OPENAI_API_KEY\s*=/.test(value))
  :400      return { path, message: 'artifact contains a secret-like string' };
        }
  :405  if (Array.isArray(value)) { ...recurse with path.index... }
  :413  if (isRecord(value))      { ...recurse with path.key... }
        │
        └─ walks the ENTIRE artifact (trace args, tool results, model output) — exactly
           the places a key could accidentally land — and FAILS the eval if it finds one.
```

**The CLI gate — `packages/evals/src/replay-runner.ts:69-94` + `scripts/eval-replay-artifacts.mjs:25-31`:**
`evaluateReplayArtifactFiles` reads each artifact, calls `evaluateReplayArtifact` (which
calls `assertCapabilityReplayArtifactShape`), folds into `{ ok, checked, failed, results }`,
and the script sets `process.exitCode = 1` if `!report.ok` — making it a real gate.

## Elaborate

This is the golden-file / snapshot-test idea, but inverted: instead of a separate
`.snap` file holding the expected output, the artifact *is* the snapshot and carries its
own verdict. The two-layer check (embed at run, re-assert at read) mirrors how a
package registry both signs an artifact at publish and re-verifies the signature at
install — the producer asserts, the consumer re-checks, neither trusts the other blindly.

The secret-scan deserves its own note because it's the one piece here that's about
*safety*, not correctness. Replay artifacts embed everything: tool arguments, full tool
results, raw model output. Any of those could, in a bad run, contain a key the model
echoed or a tool returned. Because these files get shared and promoted into the repo's
test fixtures, an un-scanned artifact is a real leak vector. The detect-and-refuse posture
(`assertions.ts:397-411`) is deliberately *not* redaction — it doesn't try to sanitize and
continue, it marks the artifact invalid so a human deals with it. That's the safer default:
a redactor that misses a format leaks silently; a refuser that misses a format just fails
to catch one, but never gives false assurance. Read `02-replay-artifact-as-snapshot.md` for
the artifact this verdict rides in, and `study-testing` for the validators, structural-diff,
and detection-scorer that power the run-time checks.

## Interview defense

**Q: Why embed the eval verdict in the artifact instead of computing it on read?**
So correctness travels with the run — debugging and regression-checking never start from
"is this valid?" But the verdict is re-verified on read (`assertions.ts:356`), so it's a
cache, not an authority; a corrupt or forged artifact still fails the gate. Embed once,
re-check always.

```
  embed only            re-verify only           AptKit: both
  fast, but blindly     correct, but no           recorded verdict +
  trusted               recorded baseline         re-checked gate
```

Anchor: `vite.config.ts:606`, `assertions.ts:355-365`.

**Q: Why scan artifacts for secrets if `.env` is already gitignored?**
Because artifacts embed tool args, tool results, and raw model output — places a key could
land *inside the data*, not in `.env`. These files get shared and promoted into fixtures,
so `findSecretLikeString` (`assertions.ts:397-411`) is the last-line guard. It refuses
rather than redacts, because a redactor that misses a format leaks silently.

**Q: What's the load-bearing line that keeps the embedded verdict honest?**
`assertions.ts:356` — `if (!isRecord(replayEval) || replayEval.ok !== true)`. Without it,
a run that *failed* its own shape check could still pass the artifact gate, making the
embedded `eval` decorative. Re-requiring `eval.ok === true` at read time is what keeps the
verdict load-bearing.

## Validate

1. **Reconstruct:** name the four skeleton steps (validate-at-run, embed, re-assert-at-read,
   secret-scan) and what each one prevents. Check against `vite.config.ts:596-606` and
   `assertions.ts:355-365`.
2. **Explain:** why does the read-time assertion re-check `eval.ok === true`
   (`assertions.ts:356`) instead of trusting the embedded value? What attack/mistake does
   that catch?
3. **Apply to a scenario:** `npm run eval:replays` exits non-zero. Walk how a single
   secret-like string in one tool result propagates from `findSecretLikeString`
   (`:397-411`) up through `evaluateReplayArtifactFiles` to the script's exit code.
4. **Defend the decision:** argue why the secret-scan refuses rather than redacts, and why
   that's the safer default for files that get promoted into the test suite.

## See also

- `02-replay-artifact-as-snapshot.md` — the artifact the `eval` block rides in.
- `01-structured-trace-events.md` — the trace the secret-scan walks.
- `audit.md` lens 7 — the local incident/prevention loop this closes.
- `study-testing` — the validators, structural-diff, and detection-scorer behind the checks.
