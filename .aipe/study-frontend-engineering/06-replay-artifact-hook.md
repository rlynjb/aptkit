# 06 — Replay-artifact hook

**Industry names:** custom hook for server-state lifecycle · "fetch-into-state with manual invalidation" · generic data hook. **Type:** Industry standard (custom React hook), project-specific to the save→load→promote artifact lifecycle.

---

## Zoom out — where this lives

`useReplayArtifacts` is the hook every workspace's panels reach for to manage the *persisted* side of a replay — saving an artifact to disk, listing saved replays, promoting one to a fixture.

```
  Where the hook sits

  ┌─ UI layer (browser) ──────────────────────────────────────┐
  │  RecommendationPanels / MonitoringPanels / …               │
  │    useReplayArtifacts({…})   ◄── ★ THIS CONCEPT ★          │ ← we are here
  │      owns: savedReplays, promotedFixtures, saving,         │
  │            promoting, selectedReviewPath, errors           │
  │      verbs: saveCurrentReplay, promoteSavedReplay,         │
  │             refreshReplayHistory, refreshPromotedFixtures  │
  └─────────────────────────┬──────────────────────────────────┘
                            │ fetch (JSON) — api.ts
  ┌─ Service (Vite middleware) ◄───────────────────────────────┐
  │  /api/replay/save  /api/replays  /api/replays/promote       │
  │  reads & writes artifacts/replays + fixtures/promoted       │
  └─────────────────────────────────────────────────────────────┘
```

The question: **a replay can be saved to disk, the saved list re-read, and a saved artifact promoted into a deterministic fixture — how do you own that whole server-state lifecycle once, for five agents whose artifact shapes differ?** You know the React-Query / SWR shape (data + isLoading + mutate + invalidate). This is the hand-rolled version of exactly that, made generic over the agent's types.

## Structure pass

Axis — **"who owns this data, and when is it stale?"** — across the kinds of state in the hook.

```
  axis: "where's the truth, and how does it go stale?"

  ┌─ ephemeral UI flags (saving, promoting) ──┐  client owns, transient
  ├─ selection (selectedReviewPath) ──────────┤  client owns, persists in session
  │            ═══════ the seam ═══════        │
  ├─ savedReplays (list of artifacts) ────────┤  SERVER owns; client caches;
  ├─ promotedFixtures ────────────────────────┤  stale after any mutation
  └────────────────────────────────────────────┘  → manual refetch invalidates
```

- **Layers:** UI flags (no server) → selection (no server) → cached server lists (server is truth) → the server itself (disk).
- **The seam** is the cache↔server boundary. `savedReplays` and `promotedFixtures` are *copies* of disk state held in `useState`. They go stale the moment you save or promote. The hook's invalidation strategy is: after a mutation, `await refresh*()` to re-read. No library, no automatic invalidation — explicit refetch.
- **The generics** (`Fixture, Mode, Replay, Artifact, SavedReplay, PromoteResult, PromotedFixture`, `useReplayArtifacts.ts:13-21`) make the same lifecycle work for recommendation artifacts (with `recommendations`) and monitoring artifacts (with `anomalies`) — the hook never names a concrete shape.

## How it works

### Move 1 — the mental model

Think of the React-Query mental model you already carry: `{ data, isLoading, error, mutate }` where a mutation invalidates the query so `data` refetches. This hook is that, written by hand: `savedReplays` is the data, `historyLoading`/`historyError` are the status, `saveCurrentReplay`/`promoteSavedReplay` are the mutations, and `refreshReplayHistory`/`refreshPromotedFixtures` are the manual `invalidate`.

```
  The pattern: fetch-into-state + mutate-then-refetch

   mount ──► useEffect ──► refreshReplayHistory ──► setSavedReplays
                          refreshPromotedFixtures ─► setPromotedFixtures

   save  ──► saveCurrentReplay ──► saveArtifact(POST)
                                 └► await refreshReplayHistory  (invalidate)

   promote ► promoteSavedReplay ► promoteReplay(POST)
                                 └► await refreshPromotedFixtures (invalidate)
```

Strategy in one line: **fetch server lists into state on mount; after every mutation, refetch the affected list to invalidate the cache.**

### Move 2 — the walkthrough

#### Part A — the loaders are memoized callbacks

`refreshReplayHistory` is a `useCallback` over `[loadSavedReplays]` (`useReplayArtifacts.ts:63-73`), and a `useEffect` calls it whenever its identity changes (`:75-77`). Because the workspace passes a stable `loadSavedReplays` function, the loader is stable and the effect fires once on mount. Same pattern for `refreshPromotedFixtures`.

What breaks if the loader weren't memoized: the `useEffect` dependency would change every render, looping the fetch. The `useCallback` is what makes "fetch on mount" actually mean once.

#### Part B — each loader is a try/catch/finally state machine

```
  refresh*  (the canonical async-into-state shape)

  setLoading(true); setError(null)
  try:    setData(await load())          // success → data
  catch:  setError(message(caught))      // failure → error string
  finally: setLoading(false)             // always clear loading
```

This three-slot shape (`loading`, `error`, `data`) repeats for history and promoted fixtures (`:64-72, :80-88`). It's the manual version of what a query library gives you free — and the reason a library would tidy this up if there were more than two queries (`audit.md` lens 4).

What breaks without the `finally`: a thrown load would leave `loading` stuck true and the refresh button disabled forever.

#### Part C — save: mutate, stamp the result, then invalidate

```
  saveCurrentReplay (useReplayArtifacts.ts:95-110)

  if not replay: return                       // nothing to save
  setSaving(true); setSaveError(null)
  try:
     artifact = buildArtifact(fixture, replay, mode, model)  // shape it
     savedPath = await saveArtifact(artifact)                // POST → disk path
     setReplay(c => c ? {...c, savedPath} : c)               // stamp the live replay
     setSelectedReviewPath(savedPath)                        // select what we just saved
     await refreshReplayHistory()                            // INVALIDATE the cache
  catch:  setSaveError(message)
  finally: setSaving(false)
```

Two subtleties. `setReplay(c => ... {...c, savedPath})` writes the saved path *back onto the in-shell replay state* — so the "Save Replay" button can flip to "Saved" without a refetch (`components.tsx:119`). And `await refreshReplayHistory()` is the cache invalidation: the saved-replays list now includes the new artifact.

What breaks without stamping `savedPath` back: the Review/Promote panel couldn't know the current run is already on disk, so it couldn't offer promotion of the just-saved artifact (`recommendation-panels.tsx:168`).

#### Part D — promote: mutate, then invalidate the *other* list

```
  promoteSavedReplay (useReplayArtifacts.ts:112-125)

  setPromotingPath(path); setHistoryError(null); setPromoteResult(null)
  try:
     result = await promoteReplay(path)        // POST: artifact → promoted fixture
     setPromoteResult(result)                  // show the promoted fixture path
     await refreshPromotedFixtures()           // INVALIDATE promoted list
  catch:  setHistoryError(message)
  finally: setPromotingPath(null)
```

`promotingPath` holds the *path being promoted* (not a boolean) so the UI can disable exactly that row's button while leaving others clickable (`recommendation-panels.tsx:237`). That's a small but real "which item is busy" pattern — a boolean would disable all rows.

#### Part E — the reset-on-context-change effect and the resolved review path

```
  useEffect(() => { setSaveError(null); setPromoteResult(null); }, [resetToken]);
```

The workspace bumps `resetToken` when the fixture or mode changes (`RecommendationWorkspace.tsx:38-40`); the hook clears stale save/promote feedback in response (`:58-61`). And `latestReviewPath` (`:127-129`) resolves *which* artifact the Review panel targets, in priority order: the current run's `savedPath`, else the explicitly selected path, else the newest saved replay matching this fixture+mode. That fallback chain is why the Review panel always has something sensible selected without the user picking.

What breaks without the reset effect: after switching fixtures, a stale "Promoted fixture: …/old.json" success banner would linger, implying you promoted the new fixture when you didn't.

### Move 3 — the principle

Server state held in the client is a cache, and a cache needs an invalidation rule. The honest minimum is: fetch on mount, and after any mutation, refetch the lists the mutation touched. Make the busy-flag granular (the path being promoted, not a global boolean) so the UI can disable exactly what's in flight. When you have only one or two such queries, hand-rolling this is fine; once you have many, the repetition of the loading/error/data/refetch shape is the signal to adopt React Query or SWR. Knowing where that line is — and that this repo is correctly below it — is the lesson.

## Primary diagram

```
  useReplayArtifacts — server-state lifecycle

  ┌─ UI: panels call the hook ─────────────────────────────────┐
  │ mount ─► useEffect ─► refreshReplayHistory ─┐               │
  │                       refreshPromotedFixtures┤              │
  │                                              ▼              │
  │  state: savedReplays[], promotedFixtures[],                 │
  │         saving, promotingPath, selectedReviewPath,          │
  │         historyLoading/Error, promotedLoading/Error,        │
  │         saveError, promoteResult                            │
  │                                                            │
  │  saveCurrentReplay ─► saveArtifact ─POST─► /api/replay/save │
  │     └► setReplay({…,savedPath}) └► await refreshReplayHistory│
  │                                                            │
  │  promoteSavedReplay ─► promoteReplay ─POST─► /api/…/promote │
  │     └► setPromoteResult └► await refreshPromotedFixtures    │
  │                                                            │
  │  latestReviewPath = replay.savedPath ?? selected ?? newest  │
  └──────────────────────────┬─────────────────────────────────┘
                            │ JSON fetch (api.ts)
  ┌─ Service: Vite middleware (disk I/O) ◄─────────────────────┐
  │ writes artifacts/replays/*.json; reads list; writes        │
  │ fixtures/promoted/*.json on promote                        │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

### Use cases

`RecommendationPanels` and `MonitoringPanels` both call it with their own loaders/builders. Recommendation passes `loadSavedReplays`, `loadPromotedFixtures`, `promoteReplay`, `buildReplayArtifact` (`RecommendationWorkspace.tsx:87-99`); Monitoring passes the `*Monitoring*` variants (`MonitoringWorkspace.tsx:90-102`). Same hook, different concrete types pinned via the generics — the hook code is identical, the artifact shapes are not. Diagnostic and Query workspaces follow the same call shape. The hook output drives `ReviewPanel`, `ReplayHistoryPanel`, and `PromotedFixturesPanel` (`recommendation-panels.tsx`).

### Code, line by line

```
  apps/studio/src/useReplayArtifacts.ts:13-45  — the generic signature

  export function useReplayArtifacts<
    Fixture extends { id: string },
    Mode extends string,
    Replay extends ReplayWithSavedPath,   ← must carry optional savedPath
    Artifact, SavedReplay extends SavedReplaySummaryLike,
    PromoteResult, PromotedFixture,
  >({
    buildArtifact,        ← (fixture,replay,mode,model)=>Artifact: shape it for save
    loadSavedReplays, loadPromotedFixtures,  ← the two queries (injected)
    promoteReplay, saveArtifact,             ← the two mutations (injected)
    fixture, mode, model, replay, resetToken, setReplay,
  }) {
       │
       └─ the hook names NO concrete artifact type. Recommendation vs
          Monitoring differ only in the injected functions and the pinned
          generics — the lifecycle code is shared verbatim
```

```
  apps/studio/src/useReplayArtifacts.ts:95-110  — save: mutate then invalidate

  const saveCurrentReplay = React.useCallback(async () => {
    if (!replay) return;
    setSaving(true); setSaveError(null);
    try {
      const artifact = buildArtifact(fixture, replay, mode, model);  ← shape
      const savedPath = await saveArtifact(artifact);                ← POST → path
      setReplay((current) => current ? { ...current, savedPath } : current);  ← stamp back
      setSelectedReviewPath(savedPath);                              ← auto-select
      await refreshReplayHistory();                                  ← INVALIDATE cache
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally { setSaving(false); }
  }, [buildArtifact, fixture, mode, model, refreshReplayHistory, replay, saveArtifact, setReplay]);
       │
       └─ `setReplay({…savedPath})` is what flips the Save button to "Saved"
          without a refetch; `await refreshReplayHistory()` is the explicit
          invalidation that brings the new artifact into the list
```

```
  apps/studio/src/useReplayArtifacts.ts:112-125  — promote: per-item busy flag

  const promoteSavedReplay = React.useCallback(async (path: string) => {
    setPromotingPath(path);                ← store WHICH path is busy (not a boolean)
    setHistoryError(null); setPromoteResult(null);
    try {
      const result = await promoteReplay(path);  ← POST: artifact → fixture
      setPromoteResult(result);
      await refreshPromotedFixtures();           ← INVALIDATE promoted list
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : String(caught));
    } finally { setPromotingPath(null); }
  }, [promoteReplay, refreshPromotedFixtures]);
       │
       └─ promotingPath = the row in flight → only that row's button disables
          (recommendation-panels.tsx:237), not the whole list
```

```
  apps/studio/src/useReplayArtifacts.ts:127-129  — resolved review target

  const latestReviewPath = replay?.savedPath              ← current run, if saved
    ?? selectedReviewPath                                 ← else explicit selection
    ?? savedReplays.find(r => r.fixture.id === fixture.id  ← else newest matching
                            && r.provider.id === mode)?.path;
```

The server side — writing artifacts under `artifacts/replays`, the traversal-guarded `resolveReplayPath` (`vite.config.ts:1415-1424`), and the promotion that rewrites an artifact into a deterministic fixture (`vite.config.ts:1306-1368`) — belongs to `study-system-design` and `study-security`. This file owns only the client-side cache lifecycle.

## Elaborate

This is the "you might not need a library" version of server-state management. React Query and SWR exist because the fetch→cache→invalidate→loading/error dance is tedious and easy to get subtly wrong (stale closures, race conditions, missing invalidation). AptKit hand-rolls it because there are exactly two queries per workspace and one user, so the library's caching, dedup, and background-refetch features would be unused weight. The hook does borrow the *good ideas* — granular busy flags, mutate-then-invalidate, a derived "current target" — without the dependency. The honest read: this is correct now, and the moment a third or fourth query shows up per workspace, or a second client could race, the repetition of the try/catch/finally blocks becomes the argument for adopting SWR. The pattern this most resembles in the library world is SWR's `mutate(key)` after a write.

What to read next: `03-shared-replay-shell.md` (the component-shaped sibling of this hook-shaped reuse), then `study-system-design` for the save/promote server lifecycle and `study-security` for the path-traversal guard.

## Interview defense

**Q: How does the saved-replay list stay fresh after you save?**
Manual invalidation. The hook fetches `savedReplays` into state on mount; `saveCurrentReplay` POSTs the artifact, stamps the returned `savedPath` back onto the live replay, then `await refreshReplayHistory()` to refetch the list. No query library — fetch-into-state plus refetch-after-mutate.

```
  save → POST → setReplay({…savedPath}) → await refreshReplayHistory (invalidate)
```
Anchor: `useReplayArtifacts.ts:95-110`.

**Q: Why is the promote busy-flag a path, not a boolean?**
So the UI disables exactly the row being promoted, not every row. `promotingPath` holds the in-flight path; each row checks `promotingPath === reviewPath`. A boolean would freeze the whole list.

Anchor: `useReplayArtifacts.ts:113`, used at `recommendation-panels.tsx:237`.

**Q: Why not React Query?**
Two queries per workspace, single user, fresh sessions — its caching, dedup, and background refetch would be unused. The hand-rolled hook borrows the good parts (granular busy state, mutate-then-invalidate). I'd reach for SWR/React Query once there were more queries or a second client that could race.

## Validate

1. **Reconstruct:** write `saveCurrentReplay` from memory — the saving flag, build, POST, stamp-back, invalidate, finally. (`useReplayArtifacts.ts:95-110`)
2. **Explain:** why is each `refresh*` wrapped in `useCallback` and called from a `useEffect`? (Stable identity → the mount effect fires once instead of looping — `:63-77`.)
3. **Apply:** the same hook serves Recommendation (recommendations) and Monitoring (anomalies). What differs between the two call sites? (Only the injected loaders/builders/promoters and the pinned generics — the hook body is identical: `RecommendationWorkspace.tsx:87` vs `MonitoringWorkspace.tsx:90`.)
4. **Defend:** you switch `promotingPath` to a boolean `promoting`. What regresses in the UI? (Promoting one row disables every row's Promote button instead of just the active one — `recommendation-panels.tsx:237`.)

## See also

- `03-shared-replay-shell.md` — component-shaped reuse; this is the hook-shaped complement.
- `05-fixture-provider-mode-switch.md` — the comparison flow also saves artifacts via these APIs.
- `audit.md` lens 4 — data-fetching-and-cache findings.
- Cross-guide: `study-system-design` (save/promote server lifecycle), `study-security` (path-traversal guard, `vite.config.ts:1415`).
