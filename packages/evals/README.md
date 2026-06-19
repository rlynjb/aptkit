# @aptkit/evals

Evaluation helpers for model outputs, replay artifacts, and rubric judging.

## What It Contains

- Structural diff helpers for model-output regression checks.
- Detection scoring helpers for anomaly-style outputs.
- Replay runner/assertion utilities.
- `RubricJudge` for model-backed rubric scoring with structured output validation.

## Example

```ts
import { RubricJudge } from '@aptkit/evals';

const judge = new RubricJudge({
  model,
  rubric: {
    id: 'brief-quality',
    title: 'Brief Quality',
    task: 'Judge whether the subject is evidence-backed.',
    dimensions: [
      {
        id: 'evidence',
        label: 'Evidence',
        description: 'Uses concrete observations.',
        scale: [
          { score: 1, description: 'No evidence' },
          { score: 2, description: 'Some evidence' },
          { score: 3, description: 'Strong evidence' },
        ],
      },
    ],
    verdicts: [{ verdict: 'pass', description: 'Ready' }],
  },
});

const result = await judge.judge({ subject: 'Conversion fell 18% after payment failures rose.' });
```

Evaluation packages should stay domain-neutral. Domain fixtures and scoring aliases belong in app or example packages.
