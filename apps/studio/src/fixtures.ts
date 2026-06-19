import type { DiagnosticFixture, MonitoringFixture, QueryFixture, RecommendationFixture, RubricImprovementFixture } from './types';
import monitoringFixture from '../../../packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json';
import diagnosticFixture from '../../../packages/agents/diagnostic-investigation/fixtures/sp-revenue-diagnostic.json';
import queryFixture from '../../../packages/agents/query/fixtures/revenue-by-state-query.json';
import electronicsSpikeFixture from '../../../packages/agents/recommendation/fixtures/electronics-spike.json';
import spRevenueDropFixture from '../../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
import voucherDropoffFixture from '../../../packages/agents/recommendation/fixtures/voucher-dropoff.json';

export const fixtures = [
  spRevenueDropFixture,
  electronicsSpikeFixture,
  voucherDropoffFixture,
] as RecommendationFixture[];

export const monitoringFixtures = [
  monitoringFixture,
] as MonitoringFixture[];

export const diagnosticFixtures = [
  diagnosticFixture,
] as DiagnosticFixture[];

export const queryFixtures = [
  queryFixture,
] as QueryFixture[];

export const rubricImprovementFixtures = [
  {
    id: 'brief-quality-actionability',
    description: 'Scores an operational brief and proposes one next practice drill.',
    rubric: {
      id: 'brief-quality',
      title: 'Brief Quality',
      task: 'Judge whether an operational brief is evidence-backed and action-oriented.',
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
        {
          id: 'actionability',
          label: 'Actionability',
          description: 'Gives a specific next action.',
          scale: [
            { score: 1, description: 'No useful action' },
            { score: 2, description: 'Broad action' },
            { score: 3, description: 'Specific action' },
          ],
        },
      ],
      verdicts: [
        { verdict: 'pass', description: 'Ready' },
        { verdict: 'revise', description: 'Needs one focused fix' },
      ],
      checks: ['mentions_evidence', 'single_fix'],
    },
    subject: 'Payment failures rose while mobile checkout fell. Retry payment health before changing campaign spend.',
    context: {
      subjectId: 'attempt-1',
      userSegment: 'operator-training',
    },
    tools: [
      {
        name: 'get_recent_judgments',
        description: 'Return recent rubric judgments for this user or subject.',
        inputSchema: { type: 'object' },
        result: {
          recent: [
            { weakestDimension: 'actionability', nextAction: 'Add one owner and one deadline.' },
            { weakestDimension: 'actionability', nextAction: 'Turn the fix into an executable assignment.' },
          ],
        },
      },
      {
        name: 'generate_next_scenario',
        description: 'Create a next practice scenario.',
        inputSchema: { type: 'object' },
        result: {
          prompt: 'Rewrite the brief with one owner, one deadline, and the evidence preserved.',
          goal: 'Make the next action executable.',
        },
      },
      {
        name: 'unsafe_write',
        description: 'Not allowed by the rubric improvement policy.',
        inputSchema: { type: 'object' },
        result: { ignored: true },
      },
    ],
    modelResponses: [
      {
        content: [{
          type: 'tool_use',
          id: 'rubric-tool-1',
          name: 'get_recent_judgments',
          input: { subjectId: 'attempt-1' },
        }],
        usage: { inputTokens: 76, outputTokens: 14 },
      },
      {
        content: [{
          type: 'text',
          text: JSON.stringify({
            judgment: {
              dimensions: {
                evidence: { score: 3, reason: 'Names payment failures and mobile checkout movement.' },
                actionability: { score: 2, reason: 'The action is plausible but lacks an owner and deadline.' },
              },
              checks: { mentions_evidence: true, single_fix: true },
              verdict: 'revise',
              fix: 'Assign an owner and deadline for the payment-health review.',
              reasoning: 'Evidence is strong; execution detail is the weak point.',
            },
            weakestDimension: 'actionability',
            nextAction: 'Name the owner and deadline for the payment-health review.',
            nextDrill: {
              prompt: 'Rewrite the brief with one owner, one deadline, and the evidence preserved.',
              goal: 'Make the next action executable.',
            },
          }),
        }],
        usage: { inputTokens: 132, outputTokens: 92 },
      },
    ],
  },
] as RubricImprovementFixture[];
