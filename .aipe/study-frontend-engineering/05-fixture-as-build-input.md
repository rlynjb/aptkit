# 05 — Fixture as build input

**Industry name(s):** build-time data inlining / static-fixture bundling.
**Type:** Project-specific (the agents' recorded JSON fixtures imported straight
into the frontend bundle).

## Zoom out, then zoom in

The recorded agent fixtures — JSON files that live next to each agent package —
are *imported* into the Studio bundle, not fetched. That single decision is what
lets the deployed GitHub Pages demo run every agent with no backend at all.
Here's where it sits.

```
  Where fixtures enter the frontend

  ┌─ packages/agents/*/fixtures/*.json ─────────────────────────┐
  │  recorded ModelResponse[] + workspace + tools (correctness  │
  │  baselines — also the agents' test inputs)                  │
  └───────────────────────────┬─────────────────────────────────┘
                              │  import (build time, Vite)
  ┌─ Build (Vite) ───────────▼──────────────────────────────────┐
  │  fixtures.ts re-exports them as typed JS arrays              │
  │  vite.config.ts imports the SAME files for the dev API       │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼  inlined in the one JS chunk
  ┌─ UI (browser, zero backend) ────────────────────────────────┐
  │  StudioHome counts them · workspaces replay them            │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how does the Pages demo replay real agent runs with
no model server and no database?"* Same answer as the docs (file 02) and the
RAG corpus (file 03): the data is known at build time, so import it and let the
bundler inline it. The twist here is that these JSON files have a *second life*
— they're the agents' test fixtures — so the frontend and the test suite share
one source of truth.

## Structure pass

**Layers:** (1) the fixture JSON (authored / promoted from real runs);
(2) the import boundary (`fixtures.ts` for UI, `vite.config.ts` for dev API);
(3) the consumers (home counts, workspaces replay).

**Axis — *where does the data come from at runtime* (lifecycle/source):**

```
  axis: runtime data source

  ┌ deployed (pages) ─┐  inlined JSON only — NO fetch, NO server
  │ STATIC_DEMO=1     │  workspaces replay the bundled fixtures
  └──────────┬────────┘
  ┌ dev ──────▼───────┐  inlined JSON for fixture mode +
  │ STATIC_DEMO unset │  live /api/* stream for openai/anthropic mode
  └───────────────────┘
```

**Seam:** the `import … from '…/fixtures/*.json'` line. On one side the file is
a package artifact (and a test baseline); on the other it's a frontend constant.
The axis flips at the bundler: a file that is "test data on disk" becomes "UI
state in the bundle" with no copy step, no API. That's the seam worth seeing.

## How it works

### Move 1 — the mental model

You know `import data from './data.json'` gives you a parsed object at build
time — no `fetch`, no `await`. Studio does exactly that with the agents'
fixtures, then treats the imported arrays as the app's seed data. The pattern is
"the network request that never happens because the answer was compiled in."

```
  The kernel — import replaces fetch

   fixtures/*.json ──import──► JS object (parsed at build)
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                                ▼
        fixtures.ts (typed arrays)        vite.config.ts (dev API)
                  │                                │
                  ▼                                ▼
        StudioHome counts · workspace      dev /api runs the real agent
        replays (no fetch)                 over the same fixture
```

### Move 2 — the walkthrough

**The import boundary — `fixtures.ts`.**
Seven JSON files are imported and re-exported as typed arrays. This is the one
place the frontend names the fixtures.

```ts
// apps/studio/src/fixtures.ts:2-14 (trimmed)
import monitoringFixture from '../../../packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json';
import spRevenueDropFixture from '../../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
// …five more…
export const fixtures = [ spRevenueDropFixture, electronicsSpikeFixture, voucherDropoffFixture ]
  as RecommendationFixture[];
export const monitoringFixtures = [ monitoringFixture ] as MonitoringFixture[];
```

The `as RecommendationFixture[]` cast is the boundary condition: JSON imports
are typed `any`/inferred, so the cast asserts the shape the rest of the UI
relies on. If a fixture's schema drifts from the type, this is where it should
be caught — but a cast *asserts* rather than *checks*, so a malformed fixture
slips through to a runtime error in the workspace. (Honest weakness; a parse +
validate would catch it at the seam.)

**Consumer one — the home screen counts them.**
`StudioHome` shows live counts by reading `.length` off the imported arrays —
the card stats are derived from build-time data, not a config number that can go
stale.

```tsx
// apps/studio/src/StudioHome.tsx:118 and :162
details={[`${fixtures.length} fixtures`, 'fixture/openai compare', 'replay promotion']}
// …
details={[`${ragQueryFixtures.length} fixtures`, 'embed → search → cite', 'in-browser rag']}
```

Add a fixture file to the array and the home card count updates itself. That's
the small payoff of deriving UI from the real data instead of hardcoding "3".

**Consumer two — workspaces replay them in-browser.**
In fixture mode, the runner feeds the imported `modelResponses` into a
`FixtureModelProvider` and runs the real agent, no network (the recommendation
runner shown; all five follow the shape).

```ts
// apps/studio/src/agent-runners.ts:20, 28-36 (trimmed)
const model = new FixtureModelProvider(fixture.modelResponses);   // recorded turns
const agent = new RecommendationAgent({ model, tools, workspace: fixture.workspace, … });
return agent.propose(fixture.anomaly, fixture.diagnosis).then((recommendations) => { … });
```

**Consumer three — the dev API imports the SAME files.**
The Vite dev middleware imports the identical JSON (`vite.config.ts:53-59`) so
that `runServer` (live openai/anthropic mode) replays against the same fixture
the browser uses for fixture mode. One source of truth across the two run paths.

**The deploy cut — `build:pages` flips `STATIC_DEMO` (layers-and-hops).**
The whole zero-backend story comes down to one env flag set in one CI step.

```
  build → deploy, the static cut

  ┌ CI (deploy-studio-pages.yml) ───────────────────────────────┐
  │ hop 1: npm run build:pages -w @aptkit/studio                 │
  │        → --mode pages → loads .env.pages (VITE_STATIC_DEMO=1)│
  └───────────────────────────┬──────────────────────────────────┘
  ┌ Vite (vite.config.ts:196) ▼──────────────────────────────────┐
  │ hop 2: base = '/aptkit/'  (subpath for Pages)                │
  │        dev /api middleware NOT included in the build         │
  └───────────────────────────┬──────────────────────────────────┘
  ┌ Browser (env.ts:1) ───────▼──────────────────────────────────┐
  │ hop 3: STATIC_DEMO=true → useReplayArtifacts skips all fetch │
  │        workspaces replay inlined fixtures only               │
  └────────────────────────────────────────────────────────────────┘
```

`STATIC_DEMO` is read once (`env.ts:1`) and checked at every network seam:
`useReplayArtifacts.ts:77/:94/:100/:120`, `AgentReplayShell.tsx:139`. The flag
is the difference between "demo with a server behind it" and "demo that is just
a static file."

### Move 3 — the principle

If the data is known at build time and the host has no backend, inline it — an
import is a fetch whose answer was already computed. The extra leverage here:
the inlined files are *also* the agents' test fixtures and promoted correctness
baselines, so the demo can't drift from what the tests assert — they're the same
bytes. The cost is a static data set (each fixture is an explicit import) and a
`as`-cast trust boundary that asserts rather than validates.

## Primary diagram

```
  Fixture as build input — the complete picture

  ┌─ packages/agents/*/fixtures/*.json ──────────────────────────┐
  │  (recorded runs · also test baselines · promoted fixtures)    │
  └───────┬───────────────────────────────────┬──────────────────┘
          │ import (UI)                        │ import (dev API)
          ▼                                    ▼
  ┌ fixtures.ts ───────────────┐      ┌ vite.config.ts ───────────┐
  │ typed arrays (as-cast)     │      │ dev /api/* replays same    │
  └───────┬────────────────────┘      └────────────────────────────┘
          ▼
  ┌─ Consumers ──────────────────────────────────────────────────┐
  │ StudioHome: `${fixtures.length} fixtures`                     │
  │ Workspaces: FixtureModelProvider(fixture.modelResponses)      │
  │ build:pages → STATIC_DEMO=1 → all fetch seams short-circuit   │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the same build-time-inlining technique as the markdown docs (file 02)
and the RAG corpus (file 03) — three faces of one idea, all driven by the
zero-backend static-host constraint that also forced the hash router (file 01).
What's distinctive about fixtures is the dual life: they're authored or
*promoted* from real agent runs (the replay → artifact → promote → fixture loop
that is aptkit's testing backbone, owned by `study-system-design` and
`study-testing`), so the same JSON is a test input, a correctness baseline, and
the frontend's seed data. The `STATIC_DEMO` flag is the small but crucial bit
that makes one codebase serve both a server-backed dev experience and a pure
static deploy.

## Interview defense

**Q: How does the deployed demo run real agents with no backend?**
The agents' recorded JSON fixtures are imported, not fetched, so Vite inlines
them into the bundle (`fixtures.ts`). In fixture mode the runner feeds the
recorded `modelResponses` into a `FixtureModelProvider` and runs the real agent
in the browser — no model server, no DB. The `build:pages` step sets
`VITE_STATIC_DEMO=1`, which makes `base` the `/aptkit/` subpath and makes the app
skip every network call, so the artifact is a pure static site.

**Q: Why import the fixtures instead of fetching them?**
The host (GitHub Pages) is static with no backend; a fetch would need a server
or copied public assets and a network hop. Importing makes the answer a compiled
constant. Bonus: the same files are the agents' test fixtures, so the demo and
the test suite share one source of truth and can't drift.

**Q: What's the risk in `as RecommendationFixture[]`?**
It's an assertion, not a check. JSON imports are loosely typed, so the cast tells
the compiler "trust me, this matches" without validating it. A fixture whose
schema drifted would compile fine and blow up at runtime in the workspace.
The fix is to parse-and-validate at the import boundary (a schema check) so a
bad fixture fails loudly at the seam, not deep in a render.

```
  the trust boundary

  *.json (any) ──as RecommendationFixture[]──► trusted by all consumers
                       ↑ asserts, doesn't validate — drift slips through
```

**Anchor:** *"Import replaces fetch — and the imported files double as the
agents' test baselines, so the demo can't drift from the tests."*

## See also

- `02-build-time-markdown-docs.md` — same inlining, markdown not JSON.
- `03-deterministic-in-browser-rag.md` — the RAG corpus is inlined the same way.
- `04-generic-replay-shell.md` — the `fixtures` prop these arrays feed.
- `audit.md` → lens 7 (build), lens 4 (the `STATIC_DEMO` cut).
- `study-system-design` / `study-testing` — the replay → promote → fixture loop
  that produces these files.
