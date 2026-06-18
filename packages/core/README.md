# @rlynjb/aptkit-core

Umbrella package for the stable AptKit recommendation slice.

This package re-exports the runtime, tool, context, prompt, eval, and recommendation-agent APIs that are ready to consume from another app.

Use focused packages directly when you want a smaller dependency surface. Use this package when you want a single package install while the library boundary is still evolving.

## GitHub Packages

The package is published to GitHub Packages as `@rlynjb/aptkit-core`.

Blooming keeps its existing imports by installing this package through an npm alias:

```sh
npm install @aptkit/core@npm:@rlynjb/aptkit-core@0.1.0
```

Consumers must route the `@rlynjb` scope to GitHub Packages and provide a token with `read:packages` access:

```ini
@rlynjb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```
