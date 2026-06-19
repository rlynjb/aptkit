# 13 — Forbidden patterns and rotating formulas

**Industry name(s):** anti-repetition / forbidden openings / formula rotation.
**Type:** Project-specific technique. **Status in this repo: not yet exercised.**

## Zoom out, then zoom in

LLMs converge on phrasings. Run the same generative chain for the same user
repeatedly and every output starts to sound identical — same openings, same
structure, same hedges. The fix is to explicitly forbid the convergent phrasings
and rotate through alternatives. AptKit has no generative chain that runs
repeatedly for one user, so it doesn't implement this. Look at where it would sit.

```
  Zoom out — where rotation would live (not present)

  ┌─ Prompt layer ──────────────────────────────────────────────┐
  │  generative output... ★ forbidden-openings list ★  ← absent   │
  │  ★ rotation history (avoid last N formulas) ★      ← absent   │
  └───────────────────────────┬──────────────────────────────────┘
  ┌─ Agent layer ────────────▼──────────────────────────────────┐
  │  AptKit's generation is one-shot per anomaly/diagnosis        │
  │  → convergence across runs isn't a problem here yet            │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern: maintain a list of forbidden openings ("Here's what I
found...", "Great question!") and a rotation of structural formulas, and inject the
recently-used ones into the prompt so the model avoids them. This matters for any
generative chain a single user sees over and over — a daily summary, a caption
generator, a recurring digest. AptKit's outputs are structured analytics
(recommendations, diagnoses), one per distinct input, so convergence isn't biting.

## Structure pass

**Layers (of the absent pattern).** Two: the *forbidden list* (static — openings
that always sound canned) and the *rotation history* (dynamic — the last N formulas
this user has seen, injected so the model avoids them).

**Axis — held constant: "does output variety matter for this capability?"**

```
  One question, traced against what exists:

  ┌─ recommendation ──────────┐  → NO: structured actions, variety irrelevant
  ┌─ diagnostic ──────────────┐  → NO: structured root-cause, variety irrelevant
  ┌─ query answer (prose) ────┐  → MAYBE: prose, but one-shot per question
  ┌─ recurring digest (absent)┐  → YES: same user, repeated → convergence bites
```

**Seam — the would-be history injection.** If built, the load-bearing seam is
"prior outputs → forbidden formulas injected into the next prompt." The axis
(does variety matter) only flips to YES at a capability that runs repeatedly for
one user — which AptKit doesn't have. That's why the concept is genuinely
not-yet-exercised rather than missing.

## How it works

#### Move 1 — the mental model

You already de-duplicate a feed: you track what the user has already seen and don't
show it again. Formula rotation is that for *phrasings* — track the openings and
structures the model has already used for this user, and forbid them on the next
generation so the output feels fresh.

```
  Rotation — forbid what was recently used

  static forbidden:  ["Here's what I found", "Great question!", "I'd be happy to"]
  rotation history:  user's last 3 outputs used formulas [A, B, A]
        │  inject both into the prompt
        ▼
  "Do not open with the forbidden phrases. Avoid formulas A and B used recently."
        │
        └─ next output picks a fresh opening/structure → variety preserved
```

#### Move 2 — the walkthrough

**Forbidden openings — the static list.** A hard-coded list of phrasings the model
gravitates toward and that always read as canned: "Here's what I found", "Great
question", "I'd be happy to help". The system prompt says "Never open with any of
these." **What it stops:** the instant-tell that this was machine-generated.
**Breaks if missing:** every output opens the same way and the user notices the
pattern by the third one.

**Rotation history — the dynamic list.** Track which structural formula each recent
output used (e.g. "lead with the number", "lead with the comparison", "lead with
the recommendation") and inject the recently-used ones with an instruction to
avoid them. **What it stops:** structural sameness even when the wording varies.
**Breaks if missing:** outputs feel templated — same skeleton, different nouns.

```
  Two lists, one prompt injection

  ┌─ static forbidden openings ──┐   never use, ever
  ┌─ rotation history (per user) ┐   avoid the last N formulas this user saw
        │  both injected into the generative prompt
        ▼
  model produces a fresh opening + a structure it hasn't used recently
```

**When it matters — and why AptKit is exempt.** This is *only* worth the
complexity for generative chains a single user runs repeatedly. AptKit's
capabilities are one-shot analytics: a recommendation per diagnosis, a diagnosis
per anomaly, an answer per question. No single user gets the same chain producing
fresh prose daily. **The honest call:** adding forbidden-opening lists to the
recommendation agent today would be premature — there's no convergence problem to
solve. When AptKit grows a recurring digest or a per-user narrative, this becomes
load-bearing.

**When it doesn't matter — ever.** One-shot classifiers (intent) and structured
outputs (recommendations, diagnoses, anomalies) don't need rotation. The output
*is* a schema; "variety" is meaningless — you want the same correct categories
every time, not fresh phrasings. The query agent's prose is the only output where
it could ever apply, and even there it's one-shot per question.

#### Move 3 — the principle

Rotation fights phrasing convergence, and convergence only hurts when one user sees
the same generative chain repeatedly. Don't add it to structured outputs or
one-shot generation — there's nothing to rotate. Add it exactly when a user would
notice the sameness, and not before. AptKit correctly doesn't have it, because it
doesn't have that shape of feature yet.

## Primary diagram

The absent pattern and why each AptKit output is exempt.

```
  Rotation — the pattern and AptKit's exemption

  ABSENT pattern (for a recurring per-user generative chain):
    static forbidden openings  ─┐
    per-user rotation history  ─┴─► inject into prompt ─► fresh output

  AptKit outputs — all exempt today:
    recommendation[] / diagnosis / anomaly[]  → STRUCTURED, variety meaningless
    intent                                    → CLASSIFIER, one word
    query answer (prose)                      → ONE-SHOT per question, no repeat
                        │
                        └─ no capability runs repeatedly for one user → no convergence
```

## Implementation in codebase

**Use cases.** None — not implemented, and correctly so. The honest anchors are the
existing output shapes, shown to demonstrate *why* rotation doesn't apply.

The structured outputs where variety is meaningless:

```
  packages/prompts/src/recommendation.ts  (lines 56–72, excerpt)

  Return ONLY a JSON array in a json fenced block of at most 3 objects.
  Each object must have: title, rationale, bloomreachFeature, steps, ...
       │
       └─ the output is a schema. You want the SAME correct fields every time, not
          "fresh phrasings." Rotation has nothing to operate on here.
```

The one-shot prose output — the only candidate, and still exempt:

```
  packages/prompts/src/query.ts  (lines 48–50)

  ## Output
  Give a clear, concise answer in plain prose. A few sentences or short markdown
  bullets are fine.
       │
       └─ prose, so phrasing exists — but it's one answer per distinct question.
          A single user doesn't get this chain producing fresh text daily, so
          convergence across runs isn't a problem yet. The day there's a recurring
          digest, this is where forbidden-openings would go.
```

## Project exercises

### EX-13.1 — Forbidden-openings list for a recurring summary (when one exists)

- **What to build:** If/when a recurring per-user summary capability is added, give
  its prompt a static forbidden-openings list and an injected rotation history of
  the last N structural formulas the user has seen.
- **Why it earns its place:** This is the *only* place the technique pays off — a
  generative chain a single user runs repeatedly. Building it elsewhere is premature.
- **Files to touch:** the new summary agent's prompt package under
  `packages/prompts/src/`, the agent's render call to inject the history.
- **Done when:** generating the summary three times for one user produces three
  distinct openings, and an eval asserts no two consecutive outputs share a
  forbidden formula.
- **Estimated effort:** one day, *after* the recurring-summary feature exists.

## Elaborate

The discipline this concept actually teaches is *not* "always add forbidden-opening
lists" — it's recognizing when phrasing convergence is a real problem versus a
non-problem. AptKit is a clean negative example: its outputs are structured
analytics and one-shot prose, so convergence across runs never bites, and adding
rotation would be complexity with no payoff. Knowing *not* to reach for a technique
is as much a part of prompt engineering as knowing how to use it.

The trap to avoid is cargo-culting rotation onto structured outputs because a blog
post said "make outputs feel more varied." A recommendation `bloomreachFeature`
field should be the *same* value for the same situation every time — that's
correctness, not staleness. Variety is only a virtue where a human reads repeated
generative prose and notices the sameness. The moment AptKit grows a daily digest
or a per-user narrative, EX-13.1 becomes worth building; until then, its absence is
the right engineering call, not a gap.

Where it connects: 02 (structured outputs are exactly where rotation does *not*
apply), 07 (the prose-vs-JSON mode distinction is what decides whether rotation
could ever matter), and 08 (forbidden-openings are the inverse of few-shot — telling
the model what *not* to produce rather than what to produce).

## Interview defense

**Q: When do you need forbidden-opening lists and formula rotation?**
Only for a generative chain one user runs repeatedly — a daily summary, a recurring
digest. LLMs converge on phrasings, so without rotation every output opens the same
way and the user notices. You inject a static forbidden-openings list and a per-user
history of recently-used formulas to avoid. It does *not* apply to structured
outputs or one-shot generation — there's nothing to rotate, and for a schema you
*want* the same correct values every time.

```
  recurring per-user prose → rotate (forbid recent openings/formulas)
  structured / one-shot     → don't (variety is meaningless or absent)
```
Anchor: "AptKit outputs are structured (`recommendation.ts:56`) or one-shot prose
(`query.ts:48`) — none recur per user, so rotation isn't implemented."

**Q: Why doesn't this repo implement it, and is that a gap?**
Not a gap — the right call. No capability runs repeatedly for one user. The outputs
are structured analytics (variety meaningless) and one-shot answers (no repeat).
Adding rotation would be complexity with no convergence problem to solve. It
becomes worth building the day there's a recurring digest, and not before.
Anchor: "structured `recommendation.ts:56`, one-shot prose `query.ts:48`."

## Validate

- **Reconstruct:** Name the two lists rotation uses (static forbidden, dynamic
  history) and what each prevents.
- **Explain:** Why is rotation meaningless for the recommendation agent's output
  (`recommendation.ts:56`) but conceivably relevant for the query agent's prose
  (`query.ts:48`)?
- **Apply:** AptKit adds a daily per-user "what changed" digest. Where does the
  forbidden-openings list go, and what gets injected per call?
- **Defend:** A teammate wants to add "vary your phrasing" to the recommendation
  prompt. Argue why that's cargo-culting, using the correctness-vs-variety
  distinction.

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — where rotation does NOT apply.
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — prose vs JSON decides whether rotation could matter.
- [08-few-shot.md](08-few-shot.md) — the inverse: telling the model what not to produce.
