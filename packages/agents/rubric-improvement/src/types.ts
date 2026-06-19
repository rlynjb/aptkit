import type { RubricDefinition, RubricJudgment } from '@aptkit/evals';

export type { RubricDefinition, RubricJudgment };

export type RubricImprovementInput = {
  subject: string;
  context?: Record<string, string>;
};

export type RubricImprovementNextDrill = {
  prompt: string;
  goal: string;
};

export type RubricImprovementResult = {
  judgment: RubricJudgment;
  weakestDimension: string;
  nextAction: string;
  nextDrill?: RubricImprovementNextDrill;
};
