# Server-side key boundary

*Server-only credential confinement + filesystem path-traversal guard ·
Secrets / trust-boundary defense · Project-specific*

## Zoom out, then zoom in

You've shipped a frontend that calls a backend, and you know the rule: the
API key lives on the server, the browser gets data, never the key. AptKit's
Studio is a Vite dev server, which blurs that line — the "server" is Vite's
own Node process and the "frontend" is the React app it serves from the same
config file. The question this file answers: do the provider keys stay on the
Node side of that line? They do, and it's worth seeing exactly how, because
one careless `define:` would ship them to the browser.

```
  Zoom out — the key boundary inside the Studio dev server

  ┌─ Node process (Vite server, TRUSTED) ───────────────────────┐
  │  loadEnv → process.env.ANTHROPIC_API_KEY / OPENAI_API_KEY    │
  │     │                                                        │
  │     ▼  used ONLY inside configureServer middleware           │
  │  /api/*/replay → provider adapter → model provider           │
  │  /api/model-status → { available: bool, model: name }        │ ← no key
  └───────────────────────────┬──────────────────────────────────┘
                              │  HTTP (NDJSON / JSON, NO key)
  ┌─ Browser tab (localhost, UNTRUSTED-ish) ─▼──────────────────┐
  │  React UI — receives traces + booleans, never a credential  │
  └───────────────────────────────────────────────────────────────┘
```

The pattern: **credentials are read into `process.env` and used only inside
server middleware; nothing injects them into the client bundle.** Plus a
second, smaller control on the same boundary — the replay endpoints constrain
a user-supplied file `path` to one directory.

## Structure pass

**Layers:** env file → Vite config (`loadEnv`) → `process.env` → server
middleware → provider adapter. The browser is a sibling consumer, not a layer
the key passes through.

**Axis — trust:** *who can read the key?* Trace it: the `.env` file is
gitignored (only the dev's disk); `process.env` is the Node process (trusted);
the middleware closures (trusted); the browser bundle — and this is the line
that must hold — *never*. The key's reachability must stop at the Node/browser
seam.

**Seam — the Node-to-browser boundary in `vite.config.ts`.** It's load-bearing
because the trust answer flips hard there: above it (middleware, providers)
the key is in scope; below it (the served React app) it must be absent. Vite
makes this seam easy to puncture — a `define:` entry or a `VITE_`-prefixed var
would bake the value into the client bundle. The audit's job is to confirm the
seam is intact.

## How it works

### Move 1 — the mental model

It's the same model as a Next.js API route reading `process.env.STRIPE_KEY`:
the secret is a server-runtime value, never a build-time client constant. The
shape is "key enters one process-global, leaves only through server-side
calls."

```
  The shape — key confined to the server side of the seam

  .env ──loadEnv──► process.env ──► middleware closure ──► provider
                         │                                    │
                         │ (NOT read by client code)          ▼
                         ╳ ─── browser bundle ───╳        model API
                         no define, no VITE_, no import.meta.env
```

### Move 2 — the walkthrough

**Load env into `process.env`, server-side.** `loadStudioEnv` calls Vite's
`loadEnv` for the workspace root and the studio dir, merges with the existing
`process.env`, and explicitly writes the four names back into `process.env`.
This runs in the Vite config — Node, not the browser.

```
  pseudocode — loadStudioEnv(mode)

  env = { ...loadEnv(mode, root, ''), ...loadEnv(mode, studioDir, ''),
          ...process.env }
  setProcessEnv('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY)   // server global
  setProcessEnv('OPENAI_API_KEY',    env.OPENAI_API_KEY)
  // note: no `define:` block returned, no value handed to the client config
```

**Providers read the key at construction, in the middleware.** When a replay
runs in `anthropic`/`openai` mode, the middleware builds a provider with
`{ apiKey: process.env.ANTHROPIC_API_KEY }`. That construction happens inside
the `configureServer` request handler — server-side — and the resulting object
never serializes to the client.

**`/api/model-status` returns booleans and names, never the key.** The status
route reports `available: Boolean(env.ANTHROPIC_API_KEY)` and the model name.
The UI needs to know *whether* a provider is configured, not the secret — so
it gets a boolean.

```
  Layers-and-hops — what crosses to the browser

  ┌─ Node middleware ─┐  hop: GET /api/model-status   ┌─ browser ──────┐
  │ env.OPENAI_API_KEY│ ────────────────────────────► │ shows "OpenAI: │
  │   → Boolean(...)  │  { available:true, model:    │  available"    │
  │                   │    "gpt-4.1" }  (NO key)      └────────────────┘
  └───────────────────┘
```

**The path-traversal guard on the same boundary.** The promote/save endpoints
accept a `path` from the POST body. `resolveReplayPath` resolves it against the
workspace root and rejects anything not under `artifacts/replays/`. Without it,
a POST could name `../../../.env` and the server would happily read and return
it — turning a local convenience endpoint into a file-disclosure hole.

```
  pseudocode — resolveReplayPath(value)

  if typeof value !== 'string': throw "path must be a string"
  replayRoot = resolve(root, 'artifacts/replays')
  path = resolve(root, value)                 // normalizes ../ segments
  if not path.startsWith(replayRoot + '/') and path !== replayRoot:
    throw "path must be under artifacts/replays"   // ← containment check
  return path
```

### Move 2 variant — the load-bearing skeleton

- **`process.env` confinement.** Remove it (e.g. return a `define:` with the
  key) and the value is inlined into the client JS — the canonical leak. The
  *absence* of client injection is the control.
- **Boolean-not-value on status.** Remove it (return the key so the UI can
  "show configured state") and you've leaked it to every browser tab. The
  boolean projection is load-bearing.
- **`resolveReplayPath` containment.** Remove it and the file endpoints read
  arbitrary paths. The `startsWith(replayRoot)` check after `resolve()` is the
  whole guard — `resolve()` collapses `../`, then the prefix test confines it.

**Optional hardening that isn't here:** the dev server has no auth, so anything
on `localhost` (another process, a malicious local script) can hit the replay
endpoints. For a single-dev local tool that's the accepted trust model; for a
shared/remote Studio it would need a bound token.

### Move 3 — the principle

Credentials are runtime server values, never client build constants — and any
endpoint that turns user input into a filesystem path must confine it after
normalization. AptKit holds both lines. The principle: **the dangerous leaks
on this boundary are the *easy* ones — a one-line `define:` or an
un-normalized `path` — so the control is "don't do the easy wrong thing,"
verified by grep.**

## Primary diagram

```
  Server-side key boundary — one frame

  ┌─ .env (gitignored) ─────────────────────────────────────────┐
  │  ANTHROPIC_API_KEY / OPENAI_API_KEY / *_MODEL               │
  └───────────────────────────┬──────────────────────────────────┘
                              │ loadStudioEnv → setProcessEnv
                              ▼
  ┌─ process.env (Node, trusted) ───────────────────────────────┐
  │  used in: requireAnthropicProvider / requireOpenAIProvider   │
  │  used in: /api/model-status → Boolean(...) + model name      │
  │  NOT used in: any define:, VITE_ var, or client import       │
  └───────────────────────────┬──────────────────────────────────┘
            HTTP (no key)      │            file endpoints
        ┌──────────────────────┤        ┌──── POST { path } ────┐
        ▼                      ▼        ▼                        │
  ┌─ browser ──────┐   ┌─ provider ──┐  resolveReplayPath ──────┘
  │ traces, bools  │   │ model API   │  confine to artifacts/replays/
  └────────────────┘   └─────────────┘  else throw
```

## Implementation in codebase

**Use cases.** Hit every time the Studio shows provider status, runs a live
(`anthropic`/`openai`) replay, or promotes/saves an artifact by path. The key
boundary holds on the first two; the path guard holds on the third.

**Keys into `process.env`, server-side:**

```
  apps/studio/vite.config.ts  (lines 830-845)

  function loadStudioEnv(mode) {
    const env = { ...loadEnv(mode, root, ''),
                  ...loadEnv(mode, studioDir, ''),
                  ...process.env };
    setProcessEnv('OPENAI_API_KEY', env.OPENAI_API_KEY);      ← server global
    setProcessEnv('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
    return env;                                                ← no define:,
  }                                                              no VITE_ key
```

**Status route leaks only a boolean + name:**

```
  apps/studio/vite.config.ts  (lines 201-215)

  anthropic: {
    available: Boolean(env.ANTHROPIC_API_KEY),   ← presence, not the value
    model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  },
        │
        └─ the only thing about the key that reaches the browser is "is it set"
```

**Provider construction stays in middleware:**

```
  apps/studio/vite.config.ts  (lines 799-808)

  function requireAnthropicProvider() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    return new AnthropicModelProvider({ apiKey, ... });   ← server-side object,
  }                                                          never serialized
```

**Path-traversal guard:**

```
  apps/studio/vite.config.ts  (lines 1415-1424)

  const replayRoot = resolve(root, 'artifacts/replays');
  const path = resolve(root, value);              ← collapses ../ segments
  if (!path.startsWith(`${replayRoot}/`) && path !== replayRoot) {
    throw new Error('path must be under artifacts/replays');  ← containment
  }
  return path;
        │
        └─ without this, POST /api/replays/promote {path:"../../.env"} would
           read and return your key file
```

## Elaborate

The "server key, client data" split is the oldest rule in web app security,
and the modern footgun is build tools that *can* inline server values into the
client (Vite `define`, Next `NEXT_PUBLIC_`, CRA `REACT_APP_`). AptKit avoids it
by never reaching for that mechanism — the keys live only in `process.env` and
the middleware. The path guard is textbook traversal defense: normalize with
`path.resolve` *then* test containment (testing before normalization is the
classic bypass). The honest limit is that the dev server is unauthenticated —
fine for one developer on `localhost`, not for a shared deployment. See
`.aipe/study-system-design/01-provider-abstraction.md` for the provider
boundary as architecture, and `02-secret-scan-guard.md` for the control that
catches a key if it ever *does* slip into an artifact.

## Interview defense

**Q: The Studio is a Vite app. How do the API keys not end up in the browser?**

> The keys are read into `process.env` in the Vite config and used only inside
> `configureServer` middleware — provider construction and the status route.
> There's no `define:` block and no `VITE_`-prefixed var, so nothing inlines
> them into the client bundle. The status endpoint returns
> `Boolean(env.KEY)` and the model name, never the value.

```
  .env → process.env → middleware/provider ──╳── browser (boolean only)
```

**Anchor:** the browser learns *whether* a key exists, never *what* it is.

**Q: Those replay endpoints take a file path from the request — isn't that a
traversal risk?**

> It would be without the guard. `resolveReplayPath` runs `path.resolve` to
> collapse `../`, then rejects anything not under `artifacts/replays/`.
> Normalize-then-contain — testing before resolving is the bypass, so the
> order matters.

**Anchor:** resolve first, then check the prefix.

## Validate

1. **Reconstruct:** name the three things that would leak a key into the
   browser bundle (a `define:` entry, a `VITE_`-prefixed var, a client import
   of `process.env`) and confirm none exist in `vite.config.ts`.
2. **Explain:** why does `/api/model-status` (`vite.config.ts:201`) return
   `Boolean(env.ANTHROPIC_API_KEY)` instead of the key?
3. **Apply:** a POST to `/api/replays/promote` sends
   `{ "path": "artifacts/replays/../../packages/.env" }`. What does
   `resolveReplayPath` (`vite.config.ts:1415`) do, and why?
4. **Defend:** the dev server has no auth. Argue when that's acceptable
   (single-dev localhost) and what it would need before a shared Studio.

## See also

- `audit.md` → lens 4 (secrets) and lens 3 (path traversal)
- `02-secret-scan-guard.md` — the downstream net if a key slips into an artifact
- `.aipe/study-system-design/01-provider-abstraction.md`
