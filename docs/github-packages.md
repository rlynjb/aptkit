# GitHub Packages

AptKit publishes the standalone core bundle to GitHub Packages as `@rlynjb/aptkit-core`.

The package is built from `packages/core`, but it is packed as a standalone tarball that bundles the AptKit runtime, tools, context, prompt, eval, and extracted agent packages used by Blooming.

## Publish

Publish with GitHub Actions:

```sh
git tag aptkit-core-v0.1.0
git push origin aptkit-core-v0.1.0
```

The `Publish AptKit Core` workflow can also be run manually from the GitHub Actions tab.

Publish locally only when your shell has a GitHub Packages token with `write:packages`:

```sh
export NODE_AUTH_TOKEN=...
npm run publish:core:github
```

## Install From Blooming

Blooming can keep importing `@aptkit/core` by installing `@rlynjb/aptkit-core` through an npm alias:

```sh
npm install @aptkit/core@npm:@rlynjb/aptkit-core@0.1.0
```

Add this `.npmrc` to Blooming so npm and Vercel can resolve the GitHub package:

```ini
@rlynjb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

For Vercel, add `GITHUB_PACKAGES_TOKEN` as an environment variable with a GitHub personal access token classic that has `read:packages` access. If the package remains private, the token also needs access to the `rlynjb/aptkit` package.
