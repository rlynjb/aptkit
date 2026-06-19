# @aptkit/agent-rubric-improvement

Agentic rubric feedback capability.

This package turns a linear judge workflow into a bounded agent that can inspect optional context/history tools, score a subject against a rubric, identify the weakest dimension, and return one next improvement action.

## Use Cases

- communication coaching
- interview answer practice
- writing feedback
- sales-call coaching
- study-answer grading
- code review coaching

## Example

```ts
import { RubricImprovementAgent } from '@aptkit/agent-rubric-improvement';

const agent = new RubricImprovementAgent({
  model,
  tools,
  rubric,
});

const result = await agent.improve({
  subject: 'Mobile checkout conversion fell after payment failures increased.',
  context: {
    goal: 'Prepare one operator-facing incident brief.',
  },
});
```

The host app owns persistence and tool implementations. This package only defines the generic agent loop, tool policy, prompts, and output validation.
