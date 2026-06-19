# @rlynjb/aptkit-core

Umbrella package for the stable AptKit recommendation slice.

This package re-exports the runtime, tool, context, prompt, eval, and recommendation-agent APIs that are ready to consume from another app.

Use focused packages directly when you want a smaller dependency surface. Use this package when you want a single package install while the library boundary is still evolving.

## npm

The package is published to npmjs as `@rlynjb/aptkit-core`.

Blooming keeps its existing imports by installing this package through an npm alias:

```sh
npm install @aptkit/core@npm:@rlynjb/aptkit-core@0.2.1
```

Because the package is public on npmjs, consumers do not need a package registry token.
