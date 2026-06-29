# Fixture as build input

**Industry name(s):** static asset / JSON module import resolved at build; embedded test
fixtures as the demo data source. **Type:** Industry standard (bundler JSON imports),
project-specific in how the same fixtures feed both the dev middleware and the static demo.

## Zoom out, then zoom in

Studio has no database and, in the Pages build, no server. Its demo data — the recorded model
turns, workspaces, tool results that drive every replay — are JSON files that live next to the
agents in `packages/agents/*/fixtures/`. They reach the running app by being **imported as
modules at build time**, so they end up embedded in the bundle. Here's where fixture imports
sit.

```
  Zoom out — where fixtures enter the frontend

  ┌─ Repo (source of truth) ─────────────────────────────────┐
  │  packages/agents/*/fixtures/*.json   apps/studio/src/*.ts │
  └───────────────────────────────┬──────────────────────────┘
                                  │ import …json  /  literal TS
  ┌─ Build layer (Vite) ──────────▼──────────────────────────┐
  │  ★ JSON → JS module, baked into the bundle ★  ← we're here│
  └───────────────────────────────┬──────────────────────────┘
                                  │ used by
  ┌─ App layer ───────────────────▼──────────────────────────┐
  │  StudioHome counts · runners replay · vite middleware runs│
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"where does Studio's data come from when there's no API and no DB,
and how does the same fixture serve both the dev server's live middleware and the static
browser-only demo?"* The answer: fixtures are build inputs — imported as JSON modules (or
authored as TS literals) and embedded — so they're available identically in both builds.

## Structure pass

**Layers:** repo files → Vite (resolves the import to a module) → the three consumers
(`StudioHome` counts, the in-browser runners, the dev middleware).

**One axis — *where does this data live at runtime?*** Trace it:

```
  Axis: "where is the fixture data at runtime?"

  ┌─ dev build ──────────────────────────────────────────────┐
  │  in the JS bundle (imported)  AND  on disk (middleware     │  → both: middleware can
  │  reads packages/.../promoted/*.json via fs at request time)│    re-read disk live
  └───────────────────────────────────────────────────────────┘
  ┌─ pages build (VITE_STATIC_DEMO=1) ───────────────────────┐
  │  ONLY in the JS bundle — no fs, no middleware              │  → must be embedded;
  │                                                            │    disk reads gated off
  └───────────────────────────────────────────────────────────┘
```

**The seam that matters:** the `STATIC_DEMO` flag (`env.ts:1`). It's the boundary that
decides whether a fixture is read from disk (dev) or only from the bundle (pages). Any code
path that reads disk — `loadSavedReplays`, `loadPromotedFixtures`, save/promote — is gated
behind it (`useReplayArtifacts.ts:77,94,100`). The embedded import is the part that works in
both worlds.

## How it works

### Move 1 — the mental model

You've `import data from './thing.json'` and gotten a typed object back — the bundler turned
the file into a module. That's the whole pattern: agent fixtures are JSON files, and importing
them inlines their contents into the bundle, same as the markdown in
`02-build-time-markdown-docs.md`. No fetch, no DB query — the data is *in the code* by the
time the browser runs.

```
  The pattern — three kinds of build-time data, one bundle

  packages/agents/recommendation/fixtures/*.json ──import──┐
  apps/studio/src/rag-query-fixtures.ts (TS literal) ──────┤──► bundle
  docs/*.md (?raw, see file 02) ──────────────────────────┘
                                                             │
                     ┌───────────────────────────────────────┤
                     ▼                  ▼                      ▼
              StudioHome counts   in-browser runners    vite middleware
              (fixtures.length)   (replay)              (also re-reads disk in dev)
```

### Move 2 — the step-by-step walkthrough

**JSON imported straight into the dev middleware.** `vite.config.ts` imports the analytics
fixtures as JSON modules and casts them to typed arrays — the middleware then replays *these*
on a fixture-mode request.

```ts
// vite.config.ts:53-59, 170-174
import monitoringFixture from '../../packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json';
import electronicsSpikeFixture from '../../packages/agents/recommendation/fixtures/electronics-spike.json';
// …
const fixtures = [spRevenueDropFixture, electronicsSpikeFixture, voucherDropoffFixture] as RecommendationFixture[];
```

The boundary condition: the import path reaches across package boundaries into sibling
packages. That's deliberate — Studio is the *consumer* of fixtures the agent packages own, so
the dependency points the right way (Studio → agents), not the reverse.

**Fixtures authored as TS literals for the in-browser RAG demo.** The RAG corpus and recorded
Gemma turns aren't separate JSON files — they're a typed TS module (`rag-query-fixtures.ts`),
so they get full type-checking and inline editing. Same build-input idea, different spelling.

```ts
// rag-query-fixtures.ts:5-18 (the corpus)
const NOTES_CORPUS = [
  { id: 'work.md',   text: 'I work as a software engineer focused on AI agents…' },
  { id: 'stack.md',  text: 'My preferred stack is TypeScript, Node, and Supabase…' },
  { id: 'coffee.md', text: 'I take my coffee as a flat white with oat milk…' },
];
export const ragQueryFixtures: RagQueryFixture[] = [ /* question + relevant + modelResponses */ ];
```

**The embedded fixtures drive the home page's live counts.** `StudioHome` doesn't hardcode
"6 fixtures" — it reads `.length` off the embedded arrays, so the UI stays truthful when a
fixture is added. It even runs a coverage computation at render from embedded data.

```tsx
// StudioHome.tsx:60-65, 162
const monitoringCoverage = coverageReport(ECOMMERCE_ANOMALY_CATEGORIES,
  schemaCapabilities(monitoringFixtures[0].workspace));     // computed from embedded fixture
// …
details={[`${ragQueryFixtures.length} fixtures`, 'embed → search → cite', 'in-browser rag']}
```

**The dev/pages split — the same fixture, two runtime sources.** In dev, the middleware can
*also* read fixtures and saved artifacts from disk at request time (`listPromotedFixtureSummaries`
reads `packages/.../promoted/*.json`, `vite.config.ts:987-1031`). In pages, there's no
middleware and no fs — so any disk-reading action short-circuits with a "local dev only" note.

```ts
// useReplayArtifacts.ts:76-79  — don't even try to fetch saved replays in the static demo
React.useEffect(() => {
  if (STATIC_DEMO) return;          // pages: no server to ask
  void refreshReplayHistory();
}, [refreshReplayHistory]);
```

```
  Layers-and-hops — same fixture, two paths

  ┌─ Repo fixture (electronics-spike.json) ─────────────────────────────┐
  │                                                                      │
  │  path A (both builds): import → bundle → StudioHome count, runners   │
  │  path B (dev only):    fs.readFile at /api/* request → middleware    │
  └──────────────────────────────────┬──────────────────────────────────┘
                                     │ STATIC_DEMO decides which paths exist
            ┌────────────────────────┴────────────────────────┐
            ▼ dev                                              ▼ pages
   bundle import + live disk reads                    bundle import ONLY
   (save / promote / history work)                    (disk actions → "local dev only")
```

### Move 2 variant — the load-bearing skeleton

The kernel: **demo data is a build input, and the runtime source is gated by one flag.**

1. **Build-time import of fixtures** (JSON modules + TS literals) — drop it and the static
   demo has no data at all; nothing replays.
2. **The `STATIC_DEMO` gate** — drop it and the Pages build tries to `fetch('/api/...')` against
   a server that isn't there, so every history/save/promote call errors instead of showing a
   graceful note.
3. **Reading counts from the embedded data, not hardcoding** — drop it and the home page lies
   the moment a fixture is added or removed.

The dev-only disk re-reads (live saved-replay history, promotion) are hardening — they make
the dev experience richer but aren't needed for the demo to function.

### Move 3 — the principle

If your "data" is fixed per deploy, make it a build input and the network seam disappears for
free — no fetch, no loading state, no server. Then gate the *richer* runtime behaviors (disk
reads, mutations) behind a single flag so one source tree produces both a full dev app and a
stripped static demo, without forking the code. The flag is the seam; the embedded data is the
floor that always works.

## Primary diagram

```
  Fixture as build input — full picture

  ┌─ Repo ────────────────────────────────────────────────────────────────┐
  │ packages/agents/*/fixtures/*.json   src/rag-query-fixtures.ts (TS)      │
  └───────────────┬──────────────────────────────────┬─────────────────────┘
                 │ import (build)                    │ import (build)
  ┌─ Vite bundle ▼──────────────────────────────────▼──────────────────────┐
  │  embedded fixture objects + recorded modelResponses                     │
  └───────┬───────────────────────┬────────────────────────────┬───────────┘
          ▼                       ▼                            ▼
   StudioHome counts       in-browser runners          vite middleware (dev)
   (fixtures.length,       (runRagQueryFixtureReplay,  (runReplay + fs reads of
    coverageReport)         runFixtureReplay)           promoted/*.json + artifacts)
                                                            │ STATIC_DEMO=1 → these
                                                            ▼ paths gated OFF (pages)
```

## Elaborate

This is the storage story for a frontend that has no storage: the same `bundledDependencies`
discipline that lets `@rlynjb/aptkit-core` ship as one tarball is mirrored here — fixtures are
inlined so the artifact is self-contained. It's the sibling of `02-build-time-markdown-docs.md`
(markdown via `?raw`) — both convert repo files into build-time modules. It also feeds the two
patterns that consume the data: `04-generic-trace-replay-shell.md` (the shell's `fixtures`
prop) and `03-deterministic-in-browser-rag.md` (the RAG corpus + recorded turns). The
fixtures themselves are the output of the replay→artifact→promote→fixture loop, which is the
`study-system-design` / `study-testing` testing backbone — here we only care that they arrive
as build inputs. The `STATIC_DEMO` gate is also a `study-security` touchpoint: it's what keeps
the static build from exposing filesystem-reading endpoints (there are none in pages).

## Interview defense

**Q: Where does the demo get its data with no DB and no backend?**
Fixtures — recorded model turns, workspaces, tool results — are JSON files (and some TS
literals) imported at build time, so they're embedded in the bundle. The home page reads
counts and coverage off those embedded arrays rather than hardcoding, so the UI never drifts
from the data.

Anchor: *"the data is in the bundle; importing it is the fetch."*

**Q: How does one codebase serve both a full dev app and a static browser-only demo?**
A single `VITE_STATIC_DEMO` flag (`.env.pages` sets it). The embedded fixtures work in both.
The richer behaviors that need the dev middleware — saving artifacts, reading saved-replay
history from disk, promoting fixtures — are gated behind that flag and degrade to a "local dev
only" note in pages, instead of erroring against a missing server.

```
  STATIC_DEMO=0 (dev):   bundle data + live disk reads + mutations
  STATIC_DEMO=1 (pages): bundle data only; disk actions → graceful note
```

Anchor: *"embedded data is the floor; the flag gates everything that needs a server."*

## See also

- `02-build-time-markdown-docs.md` — the `?raw` sibling pattern
- `03-deterministic-in-browser-rag.md` — consumes the RAG corpus + recorded turns
- `04-generic-trace-replay-shell.md` — the shell's `fixtures` come from here
- `audit.md` — lens 7 (build) and lens 4 (the dev-only network seam)
- `study-system-design` / `study-testing` — the replay→promote→fixture loop that makes them
