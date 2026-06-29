# Design Docs — AptKit

The decisions in this repo that were worth writing down, the bar they had to
clear, and a reusable template so the next one is fast to write.

This is the human layer, not the study layer. The `study-*` books exist so you
understand AptKit. These docs exist so a *room* aligns behind a decision — a
reviewer, a teammate, a promo committee. Same engineer, coach posture: lead with
the call, own the cost, surface what's open.

## Which decisions warranted a doc

A design doc is expensive attention. Spend it where the decision was
**significant and non-obvious** — hard to reverse, a real alternative existed,
cross-cutting, and someone will ask "why this way?". Here's how AptKit's
candidates ranked against that bar.

```
  AptKit decisions ranked against the warrants-a-doc bar

  decision                       reverse?   alt?   cross-cut?  asked?  → doc
  ─────────────────────────────  ────────   ────   ──────────  ──────  ─────
  emulated-tool-calling          hard       yes    yes         yes     01
    Gemma has no native tools;
    render schemas, parse JSON
  rag-from-contracts             hard       yes    yes         yes     02
    pipeline on two contracts,
    never names a vendor
  single-bundle-publishing       hard       yes    yes         yes     03
    one npm tarball, 16 pkgs
    inlined via bundledDeps
  ─────────────────────────────────────────────────────────────────────────
  replay-centric eval            medium     yes    yes         maybe   skip
  capability = pkg+policy+loop    medium     some   yes         maybe   skip
  ESM-only / NodeNext            easy       weak   no          no      skip
  Node built-in test runner      easy       yes    no          no      skip
```

Three cleared the bar. The rest are real choices but don't earn a full RFC:

- **replay-centric evaluation** (`packages/evals`) — live run → artifact → eval
  → promote to fixture → deterministic replay. Genuinely load-bearing for
  testing, but it's a well-trodden pattern (record/replay) and the "why" is
  self-evident: deterministic tests over a non-deterministic model. No room
  needs convincing. It's a *study* topic, not an *alignment* one.
- **capability = prompt package + tool policy + loop config + validator** — the
  shape every agent follows. A convention, not a contested decision; nobody was
  going to argue for the alternative. Document it in onboarding, not an RFC.
- **ESM-only, `NodeNext`, Node's built-in test runner** — defaults a reviewer
  nods at. No real alternative was on the table once the repo committed to
  modern Node. Skip.

If you're tempted to write a fourth, ask the four questions above. If you can't
answer "yes" to "someone will ask why," you're documenting a default, and a
default doesn't need a doc.

## The reusable template

Every doc here is the same nine-part spine — the canonical RFC shape. Copy it
for the next decision:

```
  The RFC spine — nine parts, same order every time

  1. Title + one-line summary    the decision in a sentence, at the top
  2. Context / problem           what forced it — real constraints, not theory
  3. Goals & non-goals           what it must do; what it explicitly won't
  4. The decision                the chosen design + a mandatory diagram
  5. Alternatives considered     2–3 real options, each with why it lost
  6. Tradeoffs accepted          what it costs, owned without flinching
  7. Risks & mitigations         what breaks, what guards it
  8. Rollout / migration         how it ships safely; what changes for callers
  9. Open questions              what's still undecided (honesty = signal)
```

How to use it:

- **Lead with the decision.** Part 1 is one sentence a skeptic can quote back.
  No suspense — the reviewer should know your call before the context.
- **Part 4 always has a diagram.** The shape before the prose. If you can't draw
  it, you don't understand it yet.
- **Part 5 is "design it twice" written down.** A doc with no alternatives reads
  as undercooked — it looks like you found the first thing that worked and
  stopped. Two-to-three real options, each with the specific reason it lost.
- **Parts 6 and 9 are where staff signal lives.** Owning the cost without an
  apology, and naming what you still don't know, is what separates a doc that
  gets the yes from a sales pitch that gets picked apart.

## The three docs

```
  01-emulated-tool-calling.md     teach a tool-less local model to call tools
  02-rag-from-contracts.md        own the RAG pipeline behind two contracts
  03-single-bundle-publishing.md  ship 16 packages as one npm tarball
```

Read them in any order — they're independent decisions. If you're walking
someone through "why does AptKit look like this," `02` is the spine (the
contract boundary that everything else rides), `01` is the cleverest local
detail, and `03` is the one that bit hardest in practice.
