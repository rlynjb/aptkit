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

Promote a useful replay into a deterministic fixture with:

```bash
npm run promote:replay -- artifacts/replays/<replay>.json
```

Promotion writes a reviewed fixture under `packages/agents/recommendation/fixtures/promoted/`. The promoted fixture captures the replay's final answer for deterministic regression testing; it does not reconstruct the live provider tool loop.

Promoted fixtures are replayed by:

```bash
npm run replay:promoted -w @aptkit/agent-recommendation
```

The recommendation package test script also runs promoted fixture replay after unit tests.

Promoted fixtures may include domain-specific behavioral expectations, for example required Bloomreach features or required text. Those checks catch regressions where the JSON shape is valid but the recommendation is no longer relevant to the fixture.
