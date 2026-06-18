import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRecommendationShape } from '@aptkit/evals';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import { FixtureModelProvider } from '../src/fixture-provider.js';
import { RecommendationAgent } from '../src/recommendation-agent.js';
import type { Anomaly, Diagnosis, WorkspaceDescriptor } from '../src/types.js';
import { assertBehavioralExpectations, type BehavioralExpectationResult, type BehavioralExpectations } from './behavioral-expectations.js';

type FixtureTool = ToolDefinition & { result: unknown };

type RecommendationFixture = {
  id: string;
  workspace: WorkspaceDescriptor;
  anomaly: Anomaly;
  diagnosis: Diagnosis;
  tools: FixtureTool[];
  modelResponses: ConstructorParameters<typeof FixtureModelProvider>[0];
  expectations?: BehavioralExpectations;
};

export type FixtureReplayResult = {
  fixture: string;
  recommendations: Awaited<ReturnType<RecommendationAgent['propose']>>;
  trace: unknown[];
  eval: ReturnType<typeof assertRecommendationShape>;
  behavior: BehavioralExpectationResult;
};

export async function runFixtureReplay(fixturePath: string): Promise<FixtureReplayResult> {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as RecommendationFixture;

  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new FixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: unknown[] = [];
  const agent = new RecommendationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    idGenerator: (() => {
      let index = 0;
      return () => `${fixture.id}-rec-${++index}`;
    })(),
    trace: { emit: (event) => trace.push(event) },
  });

  const recommendations = await agent.propose(fixture.anomaly, fixture.diagnosis);
  const evalResult = assertRecommendationShape(recommendations);
  const behavior = assertBehavioralExpectations(recommendations, fixture.expectations);

  return {
    fixture: fixture.id,
    recommendations,
    trace,
    eval: evalResult,
    behavior,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturePath = process.argv[2] ?? join(process.cwd(), 'fixtures/sp-revenue-drop.json');
  const result = await runFixtureReplay(fixturePath);
  console.log(JSON.stringify(result, null, 2));

  if (!result.eval.ok || !result.behavior.ok) {
    process.exitCode = 1;
  }
}
