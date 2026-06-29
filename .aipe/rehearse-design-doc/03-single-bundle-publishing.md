# RFC: Publish one bundle, not sixteen packages

## 1. Summary

The monorepo has 16 internal `@aptkit/*` packages but publishes **exactly one** to npm: `@rlynjb/aptkit-core` (`0.4.1`). Its `package.json` lists all 16 as `bundledDependencies`, so `npm pack` inlines their built `dist/` into a single self-contained tarball. The repo root is `"private": true`, the public surface is one file (`packages/core/src/index.ts`), and a custom packer (`scripts/pack-core-standalone.mjs`) assembles the tarball. Consumers like buffr depend on one name and import everything from it.

## 2. Context / problem

aptkit is a workspaces monorepo where the internal packages are all versioned `0.0.0` and split by concern — runtime, tools, context, retrieval, memory, five providers, six agents, etc. That split is good for *development* (clean boundaries, independent builds). It's a problem for *distribution*: a consumer doesn't want to install and version-pin 16 interdependent packages whose internal versions are all `0.0.0` and whose dependency graph they'd have to resolve themselves.

So the question is purely a packaging-and-release decision: **how does this 16-package monorepo reach a consumer as something installable?** The internal split has to stay; the external footprint has to collapse.

## 3. Goals & non-goals

**Goals**
- One `npm install @rlynjb/aptkit-core` gives a consumer the entire surface.
- One version number to track; one semver contract to honor.
- Internal packages keep their `0.0.0` dev versions and clean boundaries — distribution doesn't leak into development.
- The repo root is never publishable by accident.

**Non-goals**
- Independent versioning of sub-packages. A consumer can't take `@aptkit/retrieval@0.5` and `@aptkit/runtime@0.4` separately — it's all or nothing.
- Publishing the monorepo root or any `@aptkit/*` package directly to npm.
- A monorepo release tool (changesets / Lerna / Nx release). The packer is ~75 lines of Node.

## 4. The decision

`bundledDependencies` is the lever. List the 16 internal packages there, and `npm pack` copies their `node_modules/@aptkit/*` directories *into the tarball* — the consumer installs one package and gets all 16 inlined, no separate resolution.

```
  Single-bundle publishing — 16 packages → 1 tarball

  ┌─ Repo (private, never published) ───────────────────────────────────┐
  │  root package.json: "private": true   ← bare `npm publish` = EPRIVATE│
  │                                                                     │
  │  packages/runtime  tools  context  prompts  evals  workflows        │
  │  retrieval  memory  provider-gemma  provider-local                  │
  │  agents/{anomaly-monitoring, diagnostic-investigation, query,       │
  │          recommendation, rubric-improvement, rag-query}             │
  │        = 16 internal @aptkit/* packages, each versioned 0.0.0       │
  └──────────────────────────────────┬──────────────────────────────────┘
                                      │ re-export composition
                                      ▼
  ┌─ packages/core = @rlynjb/aptkit-core@0.4.1 ─────────────────────────┐
  │  src/index.ts          ← THE public API (one file of re-exports)    │
  │  dependencies:         all 16 @aptkit/* at "0.0.0"                   │
  │  bundledDependencies:  the SAME 16 names                            │
  │  files: ["README.md", "dist/src"]                                   │
  └──────────────────────────────────┬──────────────────────────────────┘
                                      │ scripts/pack-core-standalone.mjs
                                      │  1. npm pack -w each of the 16
                                      │  2. untar each into stage/node_modules/@aptkit/*
                                      │  3. npm pack the staged core
                                      ▼
  ┌─ npm registry ──────────────────────────────────────────────────────┐
  │  rlynjb-aptkit-core-0.4.1.tgz  (16 packages inlined, self-contained) │
  └──────────────────────────────────┬──────────────────────────────────┘
                                      │ npm install @rlynjb/aptkit-core
                                      ▼
  ┌─ Consumer (buffr) ──────────────────────────────────────────────────┐
  │  import { VectorStore, runAgentLoop, ... } from '@rlynjb/aptkit-core' │
  │  one name, one version, everything inside                            │
  └─────────────────────────────────────────────────────────────────────┘
```

The kernel — what breaks if each part is gone:

- **`bundledDependencies` (core/package.json lines 49–66)** — the 16 names that tell `npm pack` to inline them. *Remove it:* npm tries to *fetch* `@aptkit/runtime@0.0.0` from the registry on install — and it was never published, so the consumer's install fails.
- **Root `"private": true`** — makes a bare `npm publish` at the root fail with `EPRIVATE` (RELEASE.md). *Remove it:* you can accidentally publish the entire monorepo, app logic and all.
- **`packages/core/src/index.ts`** — the single re-export file *is* the public API. *Remove a re-export:* a symbol silently drops out of the published surface even though its package is bundled.
- **`scripts/pack-core-standalone.mjs` (lines 10–65)** — packs each of the 16 workspaces, untars them into a staging `node_modules`, strips `devDependencies`, then packs core. *Remove it:* you'd hand-assemble the tarball, and the staging step that makes the inlined packages resolvable is gone.

**The real scar — `"files": ["dist/src"]` on every bundled package.** This is the part that bit and the part a reviewer should hear about, because it's non-obvious. aptkit's `.gitignore` ignores `dist/`, and **`npm pack` honors `.gitignore` by default.** So a bundled package without an explicit `files` allowlist ships with *no compiled output* — the tarball inlines the package's `package.json` but none of its `.js`/`.d.ts`, and the consumer gets `has no exported member …` type errors. RELEASE.md documents this exact failure hitting `@aptkit/provider-gemma` and `@aptkit/provider-local` when they were first bundled. Every bundled package's `package.json` must carry `"files": ["README.md", "dist/src"]` or the bundle ships hollow.

That's why adding a 17th package is a **five-place change** (RELEASE.md): `index.ts` re-export, core `package.json` (both `dependencies` and `bundledDependencies`), core `tsconfig.json` references, root `build:core:deps`, and the packer's `packageSpecs`. Miss one and the bundle ships incomplete.

## 5. Alternatives considered

**A. Publish all 16 packages independently.** The "proper" monorepo answer — each `@aptkit/*` is a real npm package, the core just depends on them by version. *Why it lost:* 16 packages to version, 16 to publish in dependency order, and a consumer's `package.json` becomes a wall of pinned `@aptkit/*` lines whose versions must stay mutually compatible. For a single bundle with one consumer (buffr), that's all cost and no benefit. Flip condition: **multiple consumers needing different versions of different parts** — the moment one app wants `retrieval@0.6` while another stays on `0.4`, independent publishing earns its complexity.

**B. Git dependencies (`"@aptkit/core": "github:rlynjb/aptkit#..."`).** Skip npm entirely — point the consumer at a git ref. *Why it lost:* git deps don't run the build, so the consumer pulls source and has to compile the whole monorepo, and there's no semver — you pin a commit hash. It trades the publish step for a worse install story and no version contract.

## 6. Tradeoffs accepted

We chose one bundle, accepting **producer-side pack complexity** — the custom packer, the five-place add-a-package checklist, and the `"files"` gotcha that ships a hollow bundle if you forget it. That complexity lives entirely on the *producer* side and is paid once per release; the *consumer* side is dead simple (one install, one import, one version). For a repo with one real consumer, moving the complexity to the producer is the right trade: the person who understands the monorepo eats the packing cost so the person consuming it doesn't.

The second accepted cost: **no granular versioning.** A consumer takes all 16 at one version or none. That's fine while buffr is the only consumer; it becomes a constraint the day a second consumer wants a different slice (the flip condition above).

## 7. Risks & mitigations

```
  Risk → guard

  accidental root publish        ─► root "private": true → EPRIVATE
  bundle ships with no dist       ─► "files": ["dist/src"] per package
                                     (documented scar, RELEASE.md)
  add pkg, forget a step          ─► RELEASE.md 5-place checklist
  unpublished dep fetched on      ─► bundledDependencies inlines them;
    install                          nothing is fetched from registry
  symbol dropped from surface     ─► single index.ts re-export is the contract
  stale dist in tarball           ─► build:core:deps ordered chain before pack
```

The risk with the thinnest guard is the five-place checklist — it's documentation, not automation. Forgetting the `bundledDependencies` entry or the `"files"` allowlist produces a tarball that installs but fails at the consumer's type-check, and nothing fails earlier.

## 8. Rollout / migration

Already shipped: `0.4.0` is the last version published to npm, `0.4.1` is the repo dev version. The consumer migration on a new release is mechanical (RELEASE.md "Updating consumers"): bump `@rlynjb/aptkit-core` in buffr's `package.json`, blow away `node_modules` + lockfile, reinstall, test, commit. **The compatibility contract is the re-exported surface** — the names coming out of `index.ts` are semver-governed, and the `@aptkit/core ↔ @rlynjb/aptkit-core` alias must keep working for hosts that alias `npm:@rlynjb/aptkit-core`.

## 9. Open questions

- **When does the second consumer arrive?** That's the flip condition for the whole decision. The day two apps want different slices at different versions, single-bundle stops paying and independent publishing (Alternative A) wins. Worth pre-deciding the trigger.
- **Should the five-place checklist be a script or a test?** A `verify-bundle-complete` check that diffs `bundledDependencies` against the packer's `packageSpecs` and asserts each has `"files"` would convert the documented scar into a failing build.
- **The packer hard-codes `0.0.0` tarball names** (`aptkit-<name>-0.0.0.tgz`, packer lines 11–27). If an internal package ever takes a real version, the packer breaks silently — is pinning `0.0.0` a permanent invariant or a latent bug?

---

**Coach note.** A reviewer will ask "why not just publish them all properly?" — and the trap is sounding like you didn't know you *could*. You did; you chose against it. The framing that holds: *"One consumer, so I moved all the version complexity to the producer side and gave the consumer one install. The day a second consumer wants a different slice, that's the documented flip to independent publishing."* Then drop the scar — *"and the non-obvious cost was that `npm pack` honors `.gitignore`, so a bundled package without a `files` allowlist ships with no compiled `dist`; it bit us on the two providers."* Naming that gotcha is the thing that proves you actually shipped this and didn't read it in a guide.
