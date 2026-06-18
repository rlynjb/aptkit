# npm Publishing

AptKit publishes the standalone core bundle to npmjs as `@rlynjb/aptkit-core`.

The package is built from `packages/core`, but it is packed as a standalone tarball that bundles the AptKit runtime, tools, context, prompt, eval, and extracted agent packages used by Blooming.

## Publish

Publish `0.2.0` with GitHub Actions after adding an `NPM_TOKEN` repository secret:

1. Open the `Publish AptKit Core` workflow from the GitHub Actions tab.
2. Run the workflow manually from `main`.

For later versions, bump `packages/core/package.json` and publish with a version tag:

```sh
git tag aptkit-core-v0.1.1
git push origin aptkit-core-v0.1.1
```

Publish locally only when your shell is logged in to npm or has `NODE_AUTH_TOKEN` set:

```sh
export NODE_AUTH_TOKEN=...
npm run publish:core:npm
```

## Install From Blooming

Blooming can keep importing `@aptkit/core` by installing `@rlynjb/aptkit-core` through an npm alias:

```sh
npm install @aptkit/core@npm:@rlynjb/aptkit-core@0.2.0
```

Because this package is public on npmjs, Vercel does not need a package registry token to install it.
