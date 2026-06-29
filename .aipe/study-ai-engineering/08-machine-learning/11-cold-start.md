# Cold-start

> cold-start problem · recommender/personalization failure mode

Let me be blunt before we start: aptkit trains no model. There is no recommender, no collaborative-filtering matrix, no learned user embedding anywhere in `packages/`. This file is new ground — you are learning a failure mode you have *not* yet hit in this codebase, so I am going to scaffold it heavily rather than point at shipped code. Every concept here is `not yet exercised in aptkit`, and I will say so where it counts.

You already understand the shape of this problem from contrl, even if you never named it. Before a single rep is logged, your rep counter has nothing personal to lean on — it has to behave reasonably for a user it knows nothing about. That "behave reasonably with zero history" requirement *is* cold-start. We are just going to generalize it.

## Zoom out, then zoom in

Cold-start is not a stage in the pipeline. It is a *condition* that strikes at the boundary between training data and serving — specifically, the case where the entity you must serve (a user, an item, a whole system) has no rows in the data that the model was trained on. So the star sits on the seam, not inside a box.

```
Where cold-start bites in a supervised-ML / recommender pipeline
┌──────────┐   ┌──────────┐   ┌──────────────────┐   ┌────────┐   ┌─────────────────┐
│  Data    │──▶│ Features │──▶│ Train / Val / Test│──▶│ Model  │──▶│ Deploy / Serve  │
│ (history)│   │          │   │                   │   │        │   │  (predictions)  │
└──────────┘   └──────────┘   └──────────────────┘   └────────┘   └────────┬────────┘
      ▲                                                                     │
      │  new user / new item / new system has NO rows here                  │ request arrives
      │                                                                     ▼
      └─────────────────────────────────────────────────── ★ COLD-START ───┘
                          model is asked to predict for an entity
                          it has zero training signal about
```

Read the diagram as a loop. The model learns from `Data`. At serve time a request arrives for an entity. If that entity contributed nothing to `Data`, the learned parameters have no purchase on it — the star marks that mismatch. Cold-start is a *coverage gap between training distribution and serving population*, surfaced at request time.

## Structure pass

One axis organizes this whole topic: **how much history does the entity have, and whose history is missing?** Slide along that axis and you get the three canonical flavors, each with a different missing party.

```
Axis: what has no interaction history yet?
 less signal ◀──────────────────────────────────────────────────────▶ more signal

 NEW SYSTEM            NEW USER                NEW ITEM            WARM
 (no data at all)      (no rows for THIS user) (no rows for THIS   (history exists
                                                item)              for user+item)
 ───┬───────────────── ───┬─────────────────── ───┬─────────────── ───┬───────────
    │ bootstrap rules     │ onboarding +          │ content features  │ learned
    │ + popularity priors │ population priors      │ + popularity      │ personalization
```

The seams between these are sharp because the *fallback* differs at each. A new user can ride on the crowd's popularity priors; a new item cannot ride on a crowd it has never met; a new system has no crowd at all. Same word, three different repairs.

## How it works

### Move 1 — mental model

The mental model: **personalization is earned, not granted.** A recommender's quality is a function of accumulated signal. At zero signal you are not allowed to personalize, so you must degrade gracefully to something that needs no per-entity history. Think of it as a ladder you climb as evidence arrives.

```
PATTERN: the cold-start fallback ladder (climb as signal accumulates)
                                          signal
   ┌───────────────────────────────────┐   │
   │ rung 4: full personalization      │   │  many interactions
   │  (learned model, per-user)        │   ▲
   ├───────────────────────────────────┤   │
   │ rung 3: content-based similarity  │   │  some item/profile features
   │  (match features, not behavior)   │   ▲
   ├───────────────────────────────────┤   │
   │ rung 2: onboarding answers / rules│   │  explicit user input
   │  (ask, don't infer)               │   ▲
   ├───────────────────────────────────┤   │
   │ rung 1: popularity priors         │   │  population-level only
   │  (what works for everyone)        │   ▲
   └───────────────────────────────────┘   │  zero per-entity signal
```

You always serve from the highest rung you have evidence for. Start everyone at rung 1, promote them as their history grows. The art is the promotion thresholds.

### Move 2 — step by step

**The three flavors, named precisely.** Get the vocabulary exact, because the repair depends on which party is cold.

```
Three flavors of cold-start
┌──────────────┬──────────────────────────────┬───────────────────────────────┐
│ flavor       │ what's missing               │ primary repair                │
├──────────────┼──────────────────────────────┼───────────────────────────────┤
│ NEW USER     │ no history for THIS user;    │ onboarding questionnaire +    │
│              │ population data exists       │ population popularity priors  │
├──────────────┼──────────────────────────────┼───────────────────────────────┤
│ NEW ITEM     │ no interactions for THIS     │ content features of the item  │
│              │ item; users + model exist    │ (match to similar warm items) │
├──────────────┼──────────────────────────────┼───────────────────────────────┤
│ NEW SYSTEM   │ no data anywhere; brand-new  │ hand-written rules + explicit │
│              │ deployment                   │ preferences, earn signal      │
└──────────────┴──────────────────────────────┴───────────────────────────────┘
```

`Not yet exercised in aptkit`: there is no recommender to suffer any of these. I am defining the terms so the exercise below has language to use.

**The new-system case is the one that matters for a personal agent.** Here is the key reframe for your work. A single-user, self-hosted personal agent — buffr standing up fresh for exactly one person — is not the new-*user* case dressed up. It is the new-*system* case. There is no crowd to borrow popularity priors from. There is no population. There is exactly one human and a blank database.

```
Single-user personal agent = the NEW SYSTEM case
┌─────────────────────────────────────────────────────────────┐
│  fresh self-hosted buffr instance                            │
│                                                              │
│   population of users ......... = 1   (no crowd to average)  │
│   interaction history ......... = ∅   (empty agents schema)  │
│   learnable per-user signal ... = none yet                   │
│                                                              │
│   ▼ only rungs available at t=0                              │
│   rung 2: explicit preferences the user states               │
│   rung 1: hand-written default rules                         │
└─────────────────────────────────────────────────────────────┘
        │  user interacts over days/weeks
        ▼
┌─────────────────────────────────────────────────────────────┐
│  warming buffr instance                                      │
│   interaction history ......... grows in agents schema       │
│   ▼ now reachable                                            │
│   rung 3: content similarity over past interactions          │
│   rung 4: personalization tuned to this one person           │
└─────────────────────────────────────────────────────────────┘
```

Pseudocode for the policy — `not yet exercised in aptkit`, this is the exercise target:

```
function pick_response_strategy(user_state):
    n = count_interactions(user_state)           # from agents schema
    if n == 0:
        return RULES + EXPLICIT_PREFERENCES        # rung 1+2: bootstrap
    if n < WARM_THRESHOLD:
        return CONTENT_SIMILARITY(user_state)      # rung 3: thin signal
    return PERSONALIZED(user_state)                # rung 4: earned
```

**Promotion thresholds are the whole game.** A threshold too low and you personalize on noise — three clicks is not a personality. Too high and the user feels the agent never learns. Pick a `WARM_THRESHOLD` you can defend, log it, and revisit it once you have real interaction volume. For a one-user system, "personalize" mostly means "respect stated preferences and recent patterns," not "fit a model."

### Move 3 — principle

The principle: **never fail blank.** A cold entity is not an error state; it is the default state every entity passes through. Design the zero-signal behavior *first*, as a deliberate product surface, then treat personalization as a strict improvement layered on top. If your system only works once it is warm, it does not work.

## Primary diagram

```
Cold-start decision flow for a single-user personal agent (buffr)
                         request arrives
                               │
                               ▼
                   ┌───────────────────────┐
                   │ interactions in agents │
                   │ schema for this user?  │
                   └───────────┬───────────┘
              none             │ some            │ many
        ┌──────────────────────┼─────────────────┼─────────────────────┐
        ▼                      ▼                  ▼                     │
┌───────────────┐    ┌──────────────────┐   ┌────────────────────┐    │
│ NEW SYSTEM     │    │ thin signal       │   │ WARM               │    │
│ rules +        │    │ content           │   │ full               │    │
│ explicit prefs │    │ similarity        │   │ personalization    │    │
└───────┬────────┘    └────────┬─────────┘   └─────────┬──────────┘    │
        │                      │                       │               │
        └──────────────────────┴───────────────────────┴───────────────┘
                               │
                               ▼
                    serve response + LOG interaction
                    (this log is what warms the next request)
```

The load-bearing edge is the bottom one: every served response writes back to the history, so today's cold-start request is part of tomorrow's signal. Cold-start fixes itself only if you remember to record.

## Elaborate

A few sharp edges. First, **the new-item problem has no population escape hatch** — you cannot average over users who have used an item nobody has used. Content features (the item's own attributes) are your only purchase, which is why content-based methods are the standard new-item repair while collaborative filtering handles warm items. Second, **onboarding questionnaires are cold-start mitigations dressed as UX** — every "tell us your goals" screen is a deliberate purchase of rung-2 signal before any behavior exists. Third, **popularity priors are quietly biased**: "what's popular" entrenches whatever was already popular, so a cold user nudged toward the crowd's favorites generates more crowd-favorite signal. For a single-user agent this bias is muted (there is no crowd) but the analogous trap is anchoring too hard on the user's *first stated* preference and never re-checking it.

Cross-reference: this file is the failure-mode companion to `10-recommender-systems.md`. The recommender is the machine; cold-start is what that machine does the moment before it has anything to chew on.

## Project exercises

### Cold-start fallback policy for buffr

- **Exercise ID:** EX-ML-11a — slot this in Phase 2C, before any personalization work, because the fallback is what ships first and the personalization layers on top.
- **What to build:** A `pick_response_strategy`-style policy module in buffr that reads interaction count from the shared `agents` schema and returns one of `{bootstrap_rules, content_similarity, personalized}`, with an explicit, documented `WARM_THRESHOLD`. Wire the strategy choice into a structured log line on every request.
- **Why it earns its place:** A fresh self-hosted agent is the new-system case; without this it would either crash on empty history or pretend to personalize on noise. It also forces you to design zero-signal behavior as a deliberate surface, which is the whole principle of this file.
- **Files to touch:** `/Users/rein/Public/buffr/src/personalization/cold-start.ts` (Case B (new)); `/Users/rein/Public/buffr/src/personalization/cold-start.test.ts` (Case B (new)); a query helper for interaction counts at `/Users/rein/Public/buffr/src/db/interactions.ts` (Case B (new)).
- **Done when:** A new user with zero history is served from `bootstrap_rules`, crossing `WARM_THRESHOLD` flips the returned strategy, the chosen strategy appears in logs, and tests cover the n=0, n<threshold, and n>=threshold boundaries.
- **Estimated effort:** 1–4hr

### Onboarding-preference capture as rung-2 signal

- **Exercise ID:** EX-ML-11b — also Phase 2C, paired with 11a; the questionnaire is the deliberate purchase of explicit signal the fallback policy reads.
- **What to build:** A tiny onboarding step that records 3–5 explicit user preferences into the `agents` schema, and have the bootstrap-rules branch of EX-ML-11a consume them instead of pure defaults.
- **Why it earns its place:** It makes the abstract "rung 2" concrete and shows you understand that questionnaires *are* cold-start mitigation, not just UX polish — explicit signal short-circuits the cold period.
- **Files to touch:** `/Users/rein/Public/buffr/src/onboarding/preferences.ts` (Case B (new)); extend `/Users/rein/Public/buffr/src/personalization/cold-start.ts` (Case B (new)) to merge explicit prefs into bootstrap rules.
- **Done when:** Completing onboarding writes preferences to the schema, and a zero-history user with stored preferences gets a bootstrap response shaped by those preferences rather than raw defaults.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: Your single-user personal agent has no other users. Isn't cold-start a non-issue for you?**

The opposite — it is the hardest flavor. With many users you borrow popularity priors from the crowd. A single-user system *is* the new-system case: no crowd, empty database.

```
many users          one user (buffr)
┌────────┐          ┌────────┐
│ crowd  │──priors─▶│   ∅    │  no crowd to borrow from
└────────┘          └────────┘
```

Anchor: contrl behaves sanely before the first rep is logged — same blank-start discipline, one user, no history.

**Q: How do you pick the threshold for switching from rules to personalization?**

You don't pick it cleverly up front; you pick a defensible number, log every strategy decision, and tune once you have real interaction volume. Too low personalizes on noise, too high feels like the agent never learns.

```
n: 0 ──── WARM_THRESHOLD ──── many
   rules      ▲ tune here     personalize
```

Anchor: a rep counter that "adapted" after one ambiguous frame would be worse than one that waits — same logic.

**Q: New user vs new item — why can't the same fix cover both?**

A new user has no history but the population does, so you fall back to popularity. A new item has no history *and no population of itself* to average over, so its own content features are the only purchase.

```
new user ─▶ borrow crowd (popularity)
new item ─▶ borrow nothing; use item's own features
```

Anchor: a never-seen exercise type in a rep counter can't be inferred from other users' reps of *that* exercise — only from the motion's own features.

## See also

- [10-recommender-systems.md](./10-recommender-systems.md) — the machine cold-start sits in front of
- [12-on-device-inference.md](./12-on-device-inference.md) — where the personal agent actually runs
