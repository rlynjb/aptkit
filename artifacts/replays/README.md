# Replay Artifacts

This directory is for local replay artifacts created by commands such as:

```bash
npm run replay:model
npm run replay:openai
```

Generated `*.json` files are ignored by Git because they may include model output, fixture data, traces, and other local experiment details.

Evaluate local replay artifacts with:

```bash
npm run eval:replays
```

The eval checks the saved artifact schema, recommendation output shape, embedded replay eval status, and obvious secret-like strings.
