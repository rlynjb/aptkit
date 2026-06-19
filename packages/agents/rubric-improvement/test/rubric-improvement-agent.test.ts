import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RubricDefinition } from '@aptkit/evals';
import type { CapabilityEvent, ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import {
  RubricImprovementAgent,
  validateRubricImprovementResult,
  type RubricImprovementResult,
} from '../src/index.js';

const rubric: RubricDefinition = {
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
};

describe('RubricImprovementAgent', () => {
  it('uses allowed history tools and returns a validated improvement result', async () => {
    const model = new ScriptedModelProvider([
      {
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'get_recent_judgments',
          input: { subjectId: 'attempt-1' },
        }],
        usage: { inputTokens: 42, outputTokens: 8 },
      },
      {
        content: [{ type: 'text', text: JSON.stringify(validResult()) }],
        usage: { inputTokens: 60, outputTokens: 40 },
      },
    ]);
    const events: CapabilityEvent[] = [];
    const agent = new RubricImprovementAgent({
      model,
      tools: tools(),
      rubric,
      trace: { emit: (event) => events.push(event) },
    });

    const result = await agent.improve({
      subject: 'Payment failures rose and mobile checkout fell. Retry payment health before campaign changes.',
      context: { subjectId: 'attempt-1' },
    });

    assert.equal(result.weakestDimension, 'actionability');
    assert.match(result.nextAction, /owner/);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === 'get_recent_judgments'), true);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === 'unsafe_write'), false);
    assert.deepEqual(events.map((event) => event.type), [
      'model_usage',
      'tool_call_start',
      'tool_call_end',
      'model_usage',
      'step',
    ]);
  });

  it('recovers malformed final output with a bounded structured recovery turn', async () => {
    const model = new ScriptedModelProvider([
      { content: [{ type: 'text', text: 'mostly good but not json' }] },
      { content: [{ type: 'text', text: JSON.stringify(validResult({ nextAction: 'Name the owner and deadline.' })) }] },
    ]);
    const agent = new RubricImprovementAgent({ model, tools: tools(), rubric });

    const result = await agent.improve({ subject: 'A brief with weak action ownership.' });

    assert.equal(result.nextAction, 'Name the owner and deadline.');
    assert.equal(model.requests.length, 2);
    assert.match(String(model.requests[1]?.messages[0]?.content), /previous answer was not valid JSON/i);
  });

  it('validates rubric improvement output shape', () => {
    const validate = validateRubricImprovementResult(rubric);

    assert.equal(validate(validResult()).ok, true);
    assert.equal(validate({ ...validResult(), weakestDimension: 'unknown' }).ok, false);
    assert.equal(validate({ ...validResult(), nextAction: '' }).ok, false);
  });
});

function tools() {
  const definitions: ToolDefinition[] = [
    {
      name: 'get_recent_judgments',
      description: 'Return recent rubric judgments for this user or subject.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'generate_next_scenario',
      description: 'Create a next practice scenario.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'unsafe_write',
      description: 'Should not be advertised.',
      inputSchema: { type: 'object' },
    },
  ];
  const handlers: Record<string, ToolHandler> = {
    get_recent_judgments: () => ({
      recent: [
        { weakestDimension: 'actionability', nextAction: 'Add one owner and one date.' },
      ],
    }),
    generate_next_scenario: () => ({ prompt: 'Practice assigning owner and deadline.' }),
    unsafe_write: () => {
      throw new Error('should not be called');
    },
  };
  return new InMemoryToolRegistry(definitions, handlers);
}

function validResult(overrides: Partial<RubricImprovementResult> = {}): RubricImprovementResult {
  return {
    judgment: {
      dimensions: {
        evidence: { score: 3, reason: 'Names the payment failures and checkout drop.' },
        actionability: { score: 2, reason: 'The fix is plausible but lacks an owner.' },
      },
      checks: { mentions_evidence: true, single_fix: true },
      verdict: 'revise',
      fix: 'Add a named owner to the payment-health review.',
      reasoning: 'Evidence is strong; the action boundary is the weak point.',
    },
    weakestDimension: 'actionability',
    nextAction: 'Name the owner and deadline for the payment-health review.',
    nextDrill: {
      prompt: 'Rewrite the brief with one owner and one deadline.',
      goal: 'Make the next action executable.',
    },
    ...overrides,
  };
}

class ScriptedModelProvider implements ModelProvider {
  readonly id = 'fake';
  readonly defaultModel = 'fake-model';
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error('no scripted model response');
    return response;
  }
}
