import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RubricJudge,
  buildRubricJudgeSystemPrompt,
  createRubricJudgmentValidator,
  type RubricDefinition,
} from '../src/index.js';
import type { CapabilityEvent, ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';

const compressionRubric: RubricDefinition = {
  id: 'compression',
  title: 'Compression quality',
  task: 'Judge whether the subject preserves observation, pattern, and stakes.',
  dimensions: [
    {
      id: 'observation',
      label: 'Observation survives disagreement',
      description: 'The observation should be factual rather than a verdict.',
      scale: [
        { score: 0, description: 'verdict is embedded in the observation' },
        { score: 1, description: 'partly factual but loaded' },
        { score: 2, description: 'plain fact separated from interpretation' },
      ],
    },
    {
      id: 'stakes',
      label: 'Stakes are concrete',
      description: 'The consequence should be specific and traceable.',
      scale: [
        { score: 0, description: 'vague consequence' },
        { score: 1, description: 'directional but not traceable' },
        { score: 2, description: 'specific traceable cost' },
      ],
    },
  ],
  checks: ['twoSentences'],
  verdicts: [
    { verdict: 'tight', description: 'all dimensions are strong and checks pass' },
    { verdict: 'loose', description: 'one or more dimensions are thin' },
    { verdict: 'no-stakes', description: 'stakes score is zero' },
  ],
  calibrationExamples: [
    {
      input: 'The consumer is slower than producers, which is bad.',
      expected: 'stakes=0 verdict=no-stakes',
    },
  ],
};

class ScriptedProvider implements ModelProvider {
  readonly id = 'fixture';
  readonly defaultModel = 'fixture-model';
  readonly requests: ModelRequest[] = [];
  private readonly responses: ModelResponse[];

  constructor(responses: string[]) {
    this.responses = responses.map((text, index) => ({
      content: [{ type: 'text', text }],
      usage: { inputTokens: 10 + index, outputTokens: 3 },
      model: 'fixture-model',
    }));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    request.signal?.throwIfAborted();
    const response = this.responses.shift();
    if (!response) throw new Error('no scripted response');
    return response;
  }
}

const validJudgment = JSON.stringify({
  dimensions: {
    observation: { score: 2, reason: 'fact is separated from interpretation' },
    stakes: { score: 2, reason: 'cost is specific' },
  },
  checks: { twoSentences: true },
  verdict: 'tight',
  fix: 'Keep the same structure.',
  reasoning: 'All rubric dimensions passed.',
});

describe('rubric judge', () => {
  it('builds a generic rubric prompt without hardcoding Dryrun dimensions', () => {
    const prompt = buildRubricJudgeSystemPrompt(compressionRubric);

    assert.match(prompt, /Compression quality/);
    assert.match(prompt, /observation Observation survives disagreement/);
    assert.match(prompt, /Allowed verdicts/);
    assert.match(prompt, /"dimensions"/);
    assert.doesNotMatch(prompt, /D1 OBSERVATION/);
  });

  it('validates allowed verdicts, dimensions, checks, and score ranges', () => {
    const validate = createRubricJudgmentValidator(compressionRubric);

    const valid = validate(JSON.parse(validJudgment));
    assert.equal(valid.ok, true);

    const badVerdict = validate({
      dimensions: {
        observation: { score: 2, reason: '' },
        stakes: { score: 2, reason: '' },
      },
      checks: { twoSentences: true },
      verdict: 'excellent',
      fix: 'x',
    });
    assert.deepEqual(badVerdict, {
      ok: false,
      error: 'judgment.verdict is not allowed by the rubric',
    });

    const badScore = validate({
      dimensions: {
        observation: { score: 9, reason: '' },
        stakes: { score: 2, reason: '' },
      },
      checks: { twoSentences: true },
      verdict: 'tight',
      fix: 'x',
    });
    assert.deepEqual(badScore, {
      ok: false,
      error: 'dimensions.observation.score must be between 0 and 2',
    });
  });

  it('runs through generateStructured and emits usage trace events', async () => {
    const trace: CapabilityEvent[] = [];
    const model = new ScriptedProvider([validJudgment]);
    const judge = new RubricJudge({
      model,
      rubric: compressionRubric,
      capabilityId: 'judge.test',
      trace: { emit: (event) => trace.push(event) },
    });

    const result = await judge.judge({
      subject: 'The retry path re-posts charges without idempotency, so timed-out retries can double-charge customers.',
      context: { raw: 'payment retry incident' },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verdict, 'tight');
    assert.equal(result.value.dimensions.observation?.score, 2);
    assert.equal(result.value.checks?.twoSentences, true);
    assert.match(String(model.requests[0]?.system), /Compression quality/);
    assert.match(String(model.requests[0]?.messages[0]?.content), /Context/);
    assert.equal(trace.filter((event) => event.type === 'model_usage').length, 1);
  });

  it('retries malformed judge output with the runtime structured generator', async () => {
    const trace: CapabilityEvent[] = [];
    const model = new ScriptedProvider(['not json', validJudgment]);
    const judge = new RubricJudge({
      model,
      rubric: compressionRubric,
      trace: { emit: (event) => trace.push(event) },
    });

    const result = await judge.judge({ subject: 'subject' });

    assert.equal(result.ok, true);
    assert.equal(model.requests.length, 2);
    assert.match(String(model.requests[1]?.messages[0]?.content), /Return ONLY valid JSON/);
    assert.equal(trace.filter((event) => event.type === 'warning').length, 1);
  });
});
