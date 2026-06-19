# Secret-scan guard

*Pre-commit/pre-publish secret tripwire over serialized artifacts ·
Data-exposure defense · Project-specific*

## Zoom out, then zoom in

You know how a form validator rejects a payload before it hits the database?
Same idea, pointed the other way: before a replay artifact is accepted as
valid — and therefore eligible to be committed and *published* — a recursive
scan walks every string in it looking for anything key-shaped. If it finds
one, the artifact fails validation. The tripwire sits on the data *exit*
path, not the entry path.

```
  Zoom out — where the secret-scan sits on the publish path

  ┌─ Runtime (live run) ────────────────────────────────────────┐
  │  agent loop → artifact JSON (question, answer, trace, ...)   │
  └───────────────────────────┬──────────────────────────────────┘
                              │  assert*ReplayArtifactShape(artifact)
  ┌─ Evals layer ────────────▼──────────────────────────────────┐
  │  shape checks  +  ★ findSecretLikeString(artifact) ★         │ ← here
  │  fail → artifact not promotable                              │
  └───────────────────────────┬──────────────────────────────────┘
                              │  promote → fixture (git-committed)
  ┌─ Publish boundary ───────▼──────────────────────────────────┐
  │  bundledDependencies inlines fixtures into the npm tarball   │
  │  → @rlynjb/aptkit-core on the public registry (HOSTILE)      │
  └───────────────────────────────────────────────────────────────┘
```

The pattern: **a recursive content scan that fails-closed on a secret-like
match, gating the artifact before it can cross the publish boundary.**

## Structure pass

**Layers:** runtime produces artifacts → evals validate them → promotion
writes fixtures → publish inlines fixtures into a public tarball.

**Axis — trust (data exposure direction):** *can this string reach the public
registry?* Trace it: inside a live run, a tool result is trusted local data;
once it's serialized into an artifact and promoted to a committed fixture, it
is *world-readable on publish*. The trust level of the same bytes flips from
"local" to "public" across the promotion step.

**Seam — the validation step is the load-bearing boundary.** That's where the
"is this safe to keep?" decision is made. Below it (promotion, publish) there
is no further content check — the npm pack
(`scripts/pack-core-standalone.mjs`) doesn't re-scan. So the
`assert*ReplayArtifactShape` call is the *last* place a secret can be caught
before it's committed. Everything downstream trusts that the artifact already
passed.

## How it works

### Move 1 — the mental model

It's a depth-first walk over a JSON tree, the same shape as a recursive
`JSON.stringify` replacer, but instead of transforming it *inspects*: at each
leaf string, run two regexes; the first match short-circuits and returns the
JSON path so you know *where* the leak is.

```
  The shape — DFS over the artifact, regex at each leaf

            { } artifact
           /    |     \
      "answer" "trace" {provider}
         │       │         │
       leaf     [ ]      leaf
      test()   /   \    test()
              leaf leaf
             test() test()  ← first match wins, returns its path
```

### Move 2 — the walkthrough

**Recurse into objects and arrays, test only strings.** The function takes a
value and the path walked so far. Objects and arrays recurse, carrying the
extended path; strings are the only thing actually tested; numbers/booleans
are ignored.

```
  pseudocode — findSecretLikeString(value, path)

  if value is string:
    if /sk-[A-Za-z0-9_-]{10,}/.test(value)          // OpenAI/Anthropic key
       or /OPENAI_API_KEY\s*=/.test(value):         // literal env assignment
      return { path, message: "secret-like string" }  // ← fail, with location
    return null
  if value is array:
    for index, child in value:
      hit = findSecretLikeString(child, path + "." + index)
      if hit: return hit                            // short-circuit on first
    return null
  if value is object:
    for key, child in value:
      hit = findSecretLikeString(child, path + "." + key)
      if hit: return hit
  return null
```

**The path accumulator is the useful part.** When it fails, you don't just
get "there's a secret somewhere" — you get
`recommendations.0.steps.2: artifact contains a secret-like string`. That's
what makes the guard actionable instead of a dead-end red light.

**Fail-closed wiring.** Every artifact validator calls it and pushes the
result into the `issues` list; a non-empty `issues` list means `ok: false`,
which the promotion step treats as "not promotable." There's no "warn and
continue" path — a match blocks promotion.

```
  Flow — where a hit stops the pipeline

  artifact ─► assertQueryReplayArtifactShape
                 ├─ shape checks → issues[]
                 └─ findSecretLikeString → issue?  ── yes ─► issues.push
                                                              │
                          ok = issues.length === 0 ──────────┘
                                   │ false
                                   ▼
                    promoteCapabilityReplayArtifact throws
                    "not promotable" → never written to fixtures/
```

### Move 2 variant — the load-bearing skeleton

- **The leaf test (the two regexes).** Remove it and the walk does nothing —
  this is the actual detection. Its *narrowness* is the known weakness: it
  catches `sk-`-prefixed keys (covers OpenAI and Anthropic `sk-ant-...`) and a
  literal `OPENAI_API_KEY=` assignment. It does **not** catch generic bearer
  tokens, AWS keys, or PII.
- **The recursion.** Remove it and you'd only scan the top-level string
  fields and miss anything nested in `trace[].args` or `recommendations[]`.
  Secrets hide in nested tool results, so the depth is load-bearing.
- **The fail-closed wiring.** Remove it (e.g. log-and-continue) and a detected
  secret would still ship. The block-on-match is what makes detection a
  *control* and not just telemetry.

**Optional hardening that isn't here:** entropy scoring, a PII denylist, and a
re-scan of the *staged npm tarball* (the publish script doesn't run it). The
current scan runs over promoted artifacts, not over the final packed bytes.

### Move 3 — the principle

The right place for a secret guard is the last boundary before exposure,
failing closed. AptKit puts it at artifact-validation, which is correct in
*placement* and thin in *coverage*. The principle: **a tripwire's value is
bounded by its weakest of {what it inspects, where it sits, what it does on a
hit}.** Placement and fail-closed are strong here; the regex coverage is the
link to strengthen.

## Primary diagram

```
  Secret-scan guard — one frame

  live run ─► artifact { question, answer, recommendations, trace[...] }
                 │
                 ▼  assert*ReplayArtifactShape(artifact)
        ┌────────────────────────────────────────────┐
        │  shape checks ──────────────► issues[]      │
        │  findSecretLikeString(artifact) ──► issue?  │
        │     DFS: object → array → string            │
        │     /sk-.../  /OPENAI_API_KEY=/             │
        │     first match returns { path }            │
        └───────────────────┬────────────────────────┘
                            │ issues.length === 0 ?
                  ┌──────────┴───────────┐
               yes│                      │no
                  ▼                      ▼
        promotable → fixture     throw "not promotable"
        (git + npm tarball)      (blocked before commit)
```

## Implementation in codebase

**Use cases.** Runs inside every replay-artifact shape assertion, which the
Studio calls when listing replays and which the promotion endpoints call
before writing a fixture. So it fires on the exact path that turns a live run
into a committed, publishable fixture.

**The scanner:**

```
  packages/evals/src/assertions.ts  (lines 397-421)

  function findSecretLikeString(value, path = '') {
    if (typeof value === 'string') {
      if (/sk-[A-Za-z0-9_-]{10,}/.test(value)          ← key prefix, 10+ chars
         || /OPENAI_API_KEY\s*=/.test(value)) {        ← literal env line
        return { path, message: 'artifact contains a secret-like string' };
      }                                                  ← path = where it is
      return null;
    }
    if (Array.isArray(value)) { ...recurse with path + index... }  ← depth
    if (isRecord(value))      { ...recurse with path + key...   }  ← depth
    return null;
  }
```

**The fail-closed wiring (one of five identical call sites):**

```
  packages/evals/src/assertions.ts  (lines 120-125, in assertReplayArtifactShape)

  const secretIssue = findSecretLikeString(output);
  if (secretIssue) {
    issues.push(secretIssue);                ← a hit becomes a validation issue
  }
  return { name: 'replay-artifact-shape',
           ok: issues.length === 0,          ← any issue → ok:false
           issues };
        │
        └─ promoteCapabilityReplayArtifact throws if !ok
           (apps/studio/vite.config.ts:1309) — secret never reaches fixtures/
```

**Why this matters — the publish inlining:**

```
  packages/core/package.json  (lines 44-56)

  "bundledDependencies": [ "@aptkit/agent-query", ... all 11 ]
        │
        └─ fixtures travel with the agents into the public tarball.
           If a secret survived to a fixture, npm publish ships it worldwide.
           The scan above is the last gate before that.
```

## Elaborate

Secret-scanning is a well-trodden control (git-secrets, trufflehog,
gitleaks) and the canonical lesson there is *coverage*: narrow regexes miss
real keys. AptKit's version is correctly *placed* (last boundary, fail-closed)
but uses two patterns, so it's a tripwire for the obvious case rather than a
comprehensive scanner. The constructive move is twofold: widen the patterns
(generic 32+ char tokens, AWS `AKIA`, bearer tokens, entropy threshold) and
add a second scan over the *packed* tarball in `pack-core-standalone.mjs` /
`publish-core.yml`, so the publish itself is gated, not just promotion. See
`.aipe/study-data-modeling/` for the artifact/fixture *shape* this scans, and
`03-server-side-key-boundary.md` for the complementary control that keeps
keys from entering an artifact in the first place.

## Interview defense

**Q: How does AptKit keep secrets out of its published package?**

> Replay artifacts and fixtures get inlined into the npm tarball via
> `bundledDependencies`, so before an artifact is promotable, every shape
> assertion runs `findSecretLikeString` — a recursive DFS over the JSON that
> fails the artifact if any leaf string matches a key pattern. It fails
> closed: a hit blocks promotion, so the secret never reaches a committed
> fixture.

```
  artifact ─DFS─► leaf string ─regex─► match? ─► ok:false ─► promotion blocked
```

**Anchor:** the tripwire sits at the last door before the public registry.

**Q: What would you improve?**

> Coverage and a second gate. The regex is two patterns — `sk-` keys and a
> literal `OPENAI_API_KEY=` — so it misses generic tokens and any PII in a
> workspace metric. And it runs over promoted artifacts, not over the final
> packed tarball, so a fixture edited by hand could still publish a secret.
> I'd add entropy + denylist patterns and a scan step in the publish workflow.

**Anchor:** good placement, thin net — widen the net and add a net at the
exit.

## Validate

1. **Reconstruct:** sketch `findSecretLikeString` (`assertions.ts:397`) from
   memory — what does it test, what does it recurse into, what does it return?
2. **Explain:** why return the `path` rather than a boolean? (Actionability —
   you know *which* field leaked.)
3. **Apply:** an Anthropic key `sk-ant-api03-...` lands in
   `trace[2].result.token`. Does the scan catch it? (Yes — `sk-` prefix.)
   Now a raw AWS key `AKIA...` lands there. Does it? (No — buildable gap.)
4. **Defend:** the scan runs at promotion (`vite.config.ts:1309`) but not in
   `pack-core-standalone.mjs`. Argue whether that's sufficient given
   `bundledDependencies` (`core/package.json:44`).

## See also

- `audit.md` → lens 5 (data exposure) and lens 4 (secrets)
- `03-server-side-key-boundary.md` — keeping keys out of artifacts upstream
- `.aipe/study-data-modeling/` — the artifact/fixture shapes scanned here
