# Releasing `@rlynjb/aptkit-core`

aptkit is a private workspaces monorepo. The **only** thing published to npm is the
standalone bundle **`@rlynjb/aptkit-core`** (`packages/core`), which re-exports the
internal `@aptkit/*` packages and ships them as `bundledDependencies`. Consumers (e.g.
buffr) depend on `@rlynjb/aptkit-core` and import everything from it.

> The monorepo root is `"private": true` on purpose — never publish it. A bare
> `npm publish` in the repo root fails with `EPRIVATE`; that's expected.

## Versioning

Bump `packages/core/package.json` `version` per semver, based on what changed in the
re-exported surface:

- **patch** (`0.4.0 → 0.4.1`) — bug fixes, no API change
- **minor** (`0.4.0 → 0.5.0`) — new packages/exports added (backward compatible)
- **major** (`0.x → 1.0`) — breaking changes to exported APIs

Bump at release time (when you have something to ship), not speculatively.

## Release steps

```bash
# 1. Bump the version
#    edit packages/core/package.json -> "version"

# 2. Build everything core re-exports, then core
npm run build:core

# 3. Pack the standalone bundle (tarball with bundledDependencies)
npm run pack:core
#    -> /private/tmp/aptkit-packs/rlynjb-aptkit-core-<version>.tgz

# 4. Publish (version is derived from package.json — no hardcoded version)
npm run publish:core:npm
#    auth: with a granular access token (bypass-2FA) in ~/.npmrc this just works.
#    otherwise append an OTP:  npm run publish:core:npm -- --otp=123456

# 5. Verify
npm view @rlynjb/aptkit-core version
```

### Auth notes
- `npm whoami` must succeed. If not: `npm login`.
- npm 2FA blocks plain `npm publish`. Either pass `--otp=<6-digit>` (expires ~30s) or — the
  reliable way for a machine — create a **Granular Access Token** at
  npmjs.com → Access Tokens with **read+write** on the `@rlynjb` scope (bypasses 2FA), then
  `npm config set //registry.npmjs.org/:_authToken=npm_…`.

## Adding a NEW `@aptkit/*` package to the bundle

When a new internal package should be reachable from `@rlynjb/aptkit-core`, update **all
five** of these, or the bundle ships incomplete:

1. **`packages/core/src/index.ts`** — re-export it (`export * from '@aptkit/<name>'`, or
   explicit named exports if it collides with existing names).
2. **`packages/core/package.json`** — add to both `dependencies` and `bundledDependencies`.
3. **`packages/core/tsconfig.json`** — add a `references` entry to its path.
4. **root `package.json` → `build:core:deps`** — add `npm run build -w @aptkit/<name>` so its
   `dist/` exists before packing.
5. **`scripts/pack-core-standalone.mjs` → `packageSpecs`** — add
   `{ workspace: '@aptkit/<name>', tarball: 'aptkit-<name>-0.0.0.tgz' }`.

### ⚠️ Gotcha: every bundled package needs `"files"`

The new package's `package.json` **must** include:

```json
"files": ["README.md", "dist/src"]
```

aptkit's `.gitignore` ignores `dist/`, and `npm pack` honors `.gitignore` by default — so
**without an explicit `files` allowlist, the built `dist/` is excluded from the tarball** and
the bundle ships with no `.js`/`.d.ts` for that package (consumers get
`has no exported member …` type errors). This bit us when `@aptkit/provider-gemma` and
`@aptkit/provider-local` were first bundled.

## Updating consumers (e.g. buffr)

After publishing a new version, bump the consumer's dependency and reinstall:

```bash
# in buffr/package.json:  "@rlynjb/aptkit-core": "^<new-version>"
rm -rf node_modules package-lock.json && npm install
npm test
git commit -am "Bump @rlynjb/aptkit-core to <new-version>" && git push
```
