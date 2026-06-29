# Path-traversal containment

*Resolve-and-prefix-check for a file path from request input · Industry standard (canonicalization defense)*

## Zoom out, then zoom in

Here's Studio's dev server. It exposes a handful of `/api/*` routes; some of them take a file `path` from the POST body and read or write that file. The question this concept answers: **what stops a request from naming a path outside the directory it's supposed to touch?**

```
  Zoom out — where the gate sits

  ┌─ Client (Studio UI) ────────────────────────────────────┐
  │  fetch('/api/replays/promote', { body: { path } })       │
  └───────────────────────────┬─────────────────────────────┘
                              │ HTTP POST, path is UNTRUSTED
  ┌─ Vite middleware (dev server) ──────────────────────────┐
  │  readJsonBody → ★ resolveReplayPath(body.path) ★         │ ← we are here
  │                  → promote*ReplayArtifact(safePath)      │
  └───────────────────────────┬─────────────────────────────┘
  ┌─ Filesystem ──────────────▼─────────────────────────────┐
  │  read/write — confined to artifacts/replays/             │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this is the **canonicalize-then-contain** defense against path traversal. You've hit the bug class even if not by name — a `../../etc/passwd` in a filename, a route that serves "any file under `/public`" and accidentally serves your `.env`. The fix is always the same shape: resolve the path to its absolute, canonical form *first* (collapsing every `..`), then check that the result still lives under the directory you allow. aptkit's Studio does exactly this for every route that takes a path. It's the one genuine input-sanitization seam in the repo — worth a deep walk because it's the template for the rest.

## The structure pass

Layers: **client → middleware → filesystem**. Trace one axis — **trust** ("can this path escape the sandbox?") — across the middleware seam.

```
  axis traced = "can the path escape artifacts/replays/?"

  ┌─ request side ──┐    seam     ┌─ filesystem side ─────┐
  │ path: "../../   │ ════╪═════►  │ resolve() collapses .. │
  │  .env"          │ (resolve+    │ then prefix check:     │
  │                 │  check)      │ not under root → THROW │
  └─────────────────┘             └────────────────────────┘
         ▲                                  ▲
         └──── same axis, two answers ───────┘
           → resolveReplayPath is the seam: untrusted
             path in, contained-or-rejected path out
```

The seam is `resolveReplayPath`. On the request side the path is anything the client typed; on the filesystem side it's either confined under `artifacts/replays/` or it never gets there (the function throws). Trust flips at this one function — which is why every path-taking route funnels through it instead of trusting `body.path` directly.

## How it works

#### Move 1 — the mental model

The shape is **resolve, then assert the prefix.** The trap people fall into is checking the *raw* string for `..` — which is bypassable a dozen ways (encoding, symlinks, absolute paths). The correct move is to let the OS path resolver compute the real absolute path (which collapses `..` segments), and only *then* check it starts with your allowed root.

```
  Pattern — canonicalize before you check

   body.path = "artifacts/replays/../../buffr/.env"
        │
        ▼  resolve(root, body.path)   ← collapses the ..
   "/Users/.../buffr/.env"            ← real target, no .. left
        │
        ▼  startsWith(replayRoot + "/")?
   NO  → throw "path must be under artifacts/replays"   ✗ rejected
   YES → return the safe absolute path                  ✓ allowed
```

#### Move 2 — the load-bearing skeleton

Small kernel; walk it by what breaks. From `apps/studio/vite.config.ts:1416-1425`:

```ts
function resolveReplayPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('path must be a string'); // (A) type gate
  const root = workspaceRoot();
  const replayRoot = resolve(root, 'artifacts/replays');                   // (B) the sandbox
  const path = resolve(root, value);                                       // (C) CANONICALIZE
  if (!path.startsWith(`${replayRoot}/`) && path !== replayRoot) {         // (D) PREFIX CHECK
    throw new Error('path must be under artifacts/replays');
  }
  return path;                                                             // safe, absolute
}
```

**(A) The type gate.** A non-string `path` is rejected before anything touches the filesystem — no `resolve(root, undefined)` surprises.

**(B) The sandbox root, computed not trusted.** `replayRoot` is derived from `workspaceRoot()` (the repo root, from `import.meta.url`), not from the request. The boundary is defined server-side.

**(C) Canonicalization — the load-bearing line.** `resolve(root, value)` turns the relative, possibly-`..`-laden input into one absolute path with every `..` collapsed. Remove this and check the raw string instead, and `artifacts/replays/../../buffr/.env` *contains* the allowed prefix as a substring at the start but still escapes — the raw-string check is the classic broken version of this defense. Resolving first is what makes the prefix check sound.

**(D) The prefix check with the trailing slash.** It allows the root itself (`path !== replayRoot`) and anything genuinely *under* it (`startsWith(`${replayRoot}/`)`). The trailing slash matters: without it, a sibling directory like `artifacts/replays-evil/` would pass `startsWith("artifacts/replays")`. The `/` pins the check to children, not name-prefixed siblings. Remove the trailing slash and you reopen the escape.

```
  Execution trace — three inputs through the gate

  input "x.json"
    → resolve → /repo/artifacts/replays/x.json
    → startsWith(/repo/artifacts/replays/) ✓ → returned

  input "../../buffr/.env"
    → resolve → /repo/buffr/.env (.. collapsed)
    → startsWith ✗ → THROW

  input "../replays-evil/x"   (sibling-prefix attack)
    → resolve → /repo/artifacts/replays-evil/x
    → startsWith(/repo/artifacts/replays/) ✗ (the slash saves it) → THROW
```

**Where else it's enforced — and where it isn't needed.** Every path-taking route uses this gate: the four `*/replays/promote` handlers all call `resolveReplayPath(body.path)` before touching a file (`vite.config.ts:287`, `305`, `323`, `341`). The *write* route `/api/replay/save` doesn't take a path at all — it builds the filename server-side from a timestamp and a slugified id (`vite.config.ts:377`), so there's no traversal surface to gate. And the `list*` routes `readdir` a fixed server-computed directory, never a request path. The discipline is consistent: a path crosses the boundary only through the gate.

**The honest caveat.** This is a *dev-only* server — Vite middleware that runs during `vite dev`, unauthenticated, on localhost. The traversal gate is real and correct, but the threat it defends (a malicious local request) is low on a single-developer machine. Its value is as the *template*: if any of these routes ever ship to a shared host, the gate is already the right shape, and the rest of the route (auth, CSRF) is what would need adding — see `audit.md` lens 1 and lens 5.

#### Move 3 — the principle

Never validate a path by inspecting the string the caller sent — validate the *canonical* path the OS would actually open. Resolve first (so `..`, encodings, and relative segments are all flattened into one true absolute path), then check containment with a trailing-slash-anchored prefix so siblings don't sneak through. This is the same move whether the sink is a file read, a static-asset server, or an archive extractor (zip-slip): the bug lives in trusting the input string; the fix lives in trusting only the resolved result.

## Primary diagram

```
  Path-traversal containment — full picture

  ┌─ Client (untrusted) ────────────────────────────────────────┐
  │  POST /api/.../replays/promote   body: { path: <anything> }  │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Vite middleware ─────────▼───────────────────────────────────┐
  │  resolveReplayPath(body.path):                                │
  │    (A) string?            else throw                          │
  │    (B) replayRoot = resolve(repo, 'artifacts/replays')        │
  │    (C) path = resolve(repo, value)   ← collapse all ..        │
  │    (D) path under replayRoot/ ?      else throw               │
  │         → safe absolute path                                  │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Filesystem ──────────────▼───────────────────────────────────┐
  │  read/write confined to artifacts/replays/  (never escapes)   │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Path traversal (CWE-22) is one of the oldest input-validation bugs, and the canonicalize-then-contain fix is the textbook remedy — `path.resolve` + a prefix assertion is Node's idiom for it. The same shape generalizes to zip-slip (validate the resolved extraction path, not the archive entry name) and to static-file servers (resolve the requested path, confirm it's under the web root). What's worth recognizing in this repo: it's the *only* place untrusted input reaches a non-LLM sink, and it's handled correctly and uniformly. The contrast with `04` is instructive — there, the resource (Postgres) enforces nothing and app code is the lone guard; here, the guard is also app code, but the sink (the filesystem) is bounded by a check that fails closed. See `audit.md` lens 3 (input validation).

## Interview defense

**Q: A route takes a file path from the request body. How do you stop directory traversal?**
Resolve the path to its canonical absolute form first — `resolve(root, input)` collapses every `..` — then assert the result is under your allowed root with a trailing-slash-anchored prefix check. aptkit's `resolveReplayPath` does exactly this and every path-taking Studio route funnels through it. The trap is checking the raw string for `..`, which is bypassable; you check the resolved path, not the input.

```
   "../../.env" → resolve → /repo/.env → not under root → THROW
   "x.json"     → resolve → /repo/artifacts/replays/x.json → OK
```
*Anchor: trust the resolved path, never the input string; the trailing slash stops sibling-prefix escapes.*

**Q: Why the trailing slash in `startsWith`?** Without it, `startsWith("/repo/artifacts/replays")` also matches `/repo/artifacts/replays-evil/`, a sibling directory that isn't inside the sandbox. The `/` pins the check to actual children. It's the kind of one-character detail that's the difference between a working gate and a bypassable one.

## See also

- `04-app-id-tenancy-without-rls.md` — the other app-code-enforced boundary (contrast: that one fails open at the DB, this one fails closed at the FS).
- `audit.md` lens 1 (attack surface) and lens 3 (input validation).
