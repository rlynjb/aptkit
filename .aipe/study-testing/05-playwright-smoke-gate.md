# Playwright smoke gate (E2E wiring check)

**Industry names:** smoke test · E2E happy-path · build-verification test. **Type:**
Industry standard.

## Zoom out, then zoom in

```
  Zoom out — the smoke test is the only test above the agent layer

  ┌─ Browser (real Chrome, Playwright) ──────────────────────┐
  │  tests/studio/studio-smoke.spec.ts                       │ ← ★ here ★
  └─────────────────────────────┬─────────────────────────────┘
                                │ drives the real UI on :4187
  ┌─ Studio (React + Vite) ─────▼─────────────────────────────┐
  │  Capability Gallery → AgentReplayShell → panels            │
  │  Vite middleware: 5 replay API routes, NDJSON traces       │
  └─────────────────────────────┬─────────────────────────────┘
                                │ same fixture replay as unit tier
  ┌─ Agent + FixtureModelProvider ▼───────────────────────────┐
  │  runFixtureReplay → recorded ModelResponse[] (no live model)│
  └────────────────────────────────────────────────────────────┘
```

You know how a smoke test isn't trying to test every behavior — it just boots the
app and checks the critical path lights up, so you know the build isn't fundamentally
broken? That's exactly this. The Studio is the manual-preview UI; the smoke test
boots it in real Chrome and verifies the load-bearing wiring: cards navigate, a
fixture run bumps the counter, the result panels render. That's the pattern: **one
E2E happy-path that proves the whole stack is wired**, not that every feature is
correct.

## Structure pass

**Layers:** Playwright test → real browser → Studio React UI → Vite replay
middleware → agent fixture replay.

**Axis — what's being verified at each layer:** trace it down.

```
  One question down the stack: "what does THIS layer's failure mean?"

  ┌─ Playwright assertion ───────┐  "the user-visible thing didn't appear"
  └──────────────┬───────────────┘
  ┌─ Studio React ───────────────▼┐  "the component didn't render / wire up"
  └──────────────┬────────────────┘
  ┌─ Vite middleware ────────────▼┐  "the replay route didn't respond"
  └──────────────┬────────────────┘
  ┌─ agent fixture replay ───────▼┐  "the agent itself broke" (caught earlier by unit)
  └────────────────────────────────┘
```

**The seam:** the Vite replay middleware between the React UI and the agent. The
smoke test crosses it without naming it — clicking "Run Fixture" fires an HTTP call
to a Vite middleware route that runs the fixture replay server-side and streams the
result back. That seam is where unit tests *stop* (they call the agent directly) and
the E2E *starts* (it goes through the real HTTP + render path). The smoke test's
whole value is covering that seam the unit tests can't reach.

## How it works

### Move 1 — the mental model

```
  The smoke path — navigate, act, observe

   home ──click card──► workspace ──click "Run Fixture"──► panels render
     │                     │                                  │
   gallery               heading                        counter #1 → #2
   visible               visible                        + result heading visible
```

The strategy: **drive the real UI through one full happy-path per capability and
assert the observable effects** — navigation works, the action fires, the output
appears. No mocking of the browser, the server, or the render.

### Move 2 — step by step

**Step 1 — boot the real server.** `webServer` in the config launches Vite on port
4187 with `--strictPort` (`playwright.studio.config.ts:15`). Playwright waits for
the URL to respond before any test runs, up to 30s. `reuseExistingServer: !CI` means
locally it reuses a running dev server (fast inner loop); in CI it always boots fresh.

**Step 2 — navigate every card.** The first test loops all six capability cards,
clicks each, asserts its workspace heading appears, clicks Home, asserts the gallery
returns (`studio-smoke.spec.ts:12`). This proves routing/state for every panel in
one test.

```
  navigation assertion loop

  for each {card, heading}:
    click button matching /card/  → expect heading visible
    click "Home"                  → expect "Capability Gallery" visible
```

**Step 3 — run a fixture and watch the counter.** The action tests click "Run
Fixture", then assert the run counter incremented and the result heading rendered.

```
  the counter-increment assertion (the load-bearing one)

  runMetric = .metric:has-text('Run') strong
  before = number(runMetric.text)          ← capture baseline
  click "Run Fixture"
  expect.poll(() => number(runMetric.text)).toBeGreaterThan(before)  ← wait, don't sleep
  expect(heading 'Recommendations').toBeVisible()                    ← output rendered
```

**Step 4 — assert the *right* output, not just any.** The runtime-utilities test
goes further: after running fixtures it asserts specific text — "Checkout payment
failures", "cloud-fixture" (`studio-smoke.spec.ts:39`) — proving the fixture data
actually flowed to the panels, not that an empty panel rendered.

**The flakiness defenses — why this doesn't train people to ignore red.** Three
deliberate choices: (1) `expect.poll` (`studio-smoke.spec.ts:67`) instead of a fixed
sleep — it retries until the counter changes or times out, so it's robust to replay
latency; (2) a 5s `expect` timeout (`playwright.studio.config.ts:7`) so a hung
assertion fails fast; (3) `trace: 'retain-on-failure'` (`playwright.studio.config.ts:13`)
keeps a full Playwright trace when a test fails, so a flake is debuggable instead of
mysterious.

### Move 3 — the principle

A smoke test's job is *coverage of the wiring*, not coverage of the logic. It trades
depth for breadth across the integration seams the cheaper tests can't reach (real
HTTP, real render, real navigation). One happy-path per capability is enough — if
the wiring's broken, this goes red before a user sees a blank screen.

## Primary diagram

```
  Playwright smoke gate — full picture

  ┌─ Playwright (Chrome, :4187) ─────────────────────────────┐
  │  goto('/') → expect 'Capability Gallery'                  │
  │  click 'Query Agent' card → expect 'Query Replay' heading │
  │  capture run counter = #N                                 │
  │  click 'Run Fixture'                                      │
  │       │ HTTP → Vite replay middleware route               │
  │       ▼                                                   │
  │  server runs runFixtureReplay (FixtureModelProvider)      │
  │       │ NDJSON trace streams back                         │
  │       ▼                                                   │
  │  expect.poll(counter > N)  +  expect 'Answer' heading     │
  └────────────────────────────────────────────────────────────┘
   webServer boots Vite; reuseExistingServer locally, fresh in CI
```

## Implementation in codebase

**Use cases:**
1. Catch a broken Studio build before it ships — a bad import or a renamed panel
   heading fails the smoke before anyone opens the browser.
2. Verify the Vite replay middleware still wires the UI to the agent fixture replay
   end to end (the seam unit tests skip).
3. Prove every capability card is reachable and renders its panels.

**Code side by side — the increment + render assertion**
(`tests/studio/studio-smoke.spec.ts`):

```
  tests/studio/studio-smoke.spec.ts  (lines 57–69)

  await page.getByRole('button', { name: /Recommendation Agent/ }).click();
  await expect(page.getByRole('heading',
    { name: 'Recommendation Agent Replay' })).toBeVisible();      ← navigation works

  const runMetric = page.locator('.metric')
    .filter({ hasText: 'Run' }).locator('strong');
  const before = Number((await runMetric.textContent())
    ?.replace('#', '') ?? '0');                                   ← baseline counter

  await page.getByRole('button', { name: 'Run Fixture' }).click();
  await expect.poll(async () => Number((await runMetric.textContent())
    ?.replace('#', '') ?? '0')).toBeGreaterThan(before);          ← poll, don't sleep
  await expect(page.getByRole('heading',
    { name: 'Recommendations' })).toBeVisible();                  ← output rendered
        │
        └─ expect.poll is the anti-flake move: it tolerates replay latency by
           retrying instead of racing a fixed timeout (load-bearing for stability)
```

**Code side by side — the config that makes it CI-safe**
(`playwright.studio.config.ts`):

```
  playwright.studio.config.ts  (lines 9–20)

  use: {
    baseURL: 'http://127.0.0.1:4187',
    channel: 'chrome',
    trace: 'retain-on-failure',           ← keep a trace when a test fails (debuggable)
  },
  webServer: {
    command: 'npm run dev -w @aptkit/studio -- --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: !process.env.CI, ← reuse locally, fresh boot in CI
    timeout: 30_000,                      ← 30s to boot Vite (the flake risk, see below)
  },
```

## Elaborate

Smoke testing comes from manufacturing — power on the board, check it doesn't smoke
before deeper QA. In software it's the build-verification test: the cheap, broad
check that the system is fundamentally wired before you bother with the expensive
specific tests. AptKit's smoke is well-scoped: it deliberately does NOT assert the
agent's *output is correct* (that's the unit + fixture tiers) — it asserts the *UI
wires to the agent and renders*. That separation keeps it stable.

The one flake risk, named honestly: the `webServer` boot has a 30s budget
(`playwright.studio.config.ts:19`). On a cold machine, a fresh Vite build can race
that timeout. It hasn't been a problem, but if it ever flakes, the fix is to
pre-build the Studio app in CI before the smoke step and/or raise the timeout
(`audit.md` lens 4). And the bigger gap: this smoke runs only locally — no CI
workflow invokes `npm run smoke:studio` (`audit.md` lens 7).

Where it connects: it drives the exact same `runFixtureReplay` + `FixtureModelProvider`
as `01-replay-as-test.md`, just through the browser and Vite middleware instead of
directly. Same determinism guarantee — no live model in the smoke path.

## Interview defense

**Q: You have a UI over an LLM agent. What's your one E2E test?**
> A smoke test per capability: boot the real app, click the card, run a fixture,
> assert the counter bumps and the result panel renders. It proves the wiring — UI →
> HTTP → agent replay → render — not the agent's correctness, which the unit tier
> already owns. Drives a fixture, so it's deterministic, no live model.

```
  goto → click card → expect heading → Run Fixture → poll counter↑ → expect panel
```
> Anchor: smoke = breadth across the wiring seams, not depth on the logic.

**Q: How do you keep it from being flaky?**
> `expect.poll` instead of fixed sleeps so it tolerates replay latency, a short
> `expect` timeout so hangs fail fast, and `retain-on-failure` traces so a flake is
> debuggable. The real risk is the dev-server boot timeout — pre-build in CI to
> remove it.

## Validate

1. **Reconstruct:** list the three things the smoke asserts per capability
   (navigation, counter increment, panel render). Check `studio-smoke.spec.ts:57`.
2. **Explain:** why `expect.poll` instead of `await page.waitForTimeout(...)` then
   assert? (`studio-smoke.spec.ts:67`.)
3. **Apply:** someone renames the "Recommendations" panel heading. Which test fails
   and at which line? (`studio-smoke.spec.ts:68`.)
4. **Defend:** why does the smoke NOT assert the recommendation content is correct,
   only that *a* recommendations heading renders?

## See also

- `01-replay-as-test.md` — the fixture replay the smoke drives through the UI.
- `03-promote-to-fixture-baseline.md` — where the fixtures the UI runs come from.
- `study-frontend-engineering` / `study-system-design` — the Studio + Vite middleware.
- `audit.md` lens 4 (flakiness) and lens 7 (no CI gate).
