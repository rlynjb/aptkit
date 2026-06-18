import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import { FixtureModelProvider, QueryAgent, validateQueryAnswer, type Intent, type WorkspaceDescriptor } from '../src/index.js';
import fixture from '../fixtures/revenue-by-state-query.json' with { type: 'json' };

type FixtureTool = ToolDefinition & { result: unknown };

type QueryFixture = typeof fixture & {
  workspace: WorkspaceDescriptor;
  intent: Intent;
  tools: FixtureTool[];
  expectations?: QueryBehaviorExpectations;
};

type QueryBehaviorExpectations = {
  requiredAnswerText?: string[];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2];
  const result = await runFixtureReplay(fixturePath);
  console.log(JSON.stringify(result, null, 2));
}

export async function runFixtureReplay(path?: string) {
  const replayFixture = path
    ? JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8')) as QueryFixture
    : fixture as QueryFixture;

  const handlers: Record<string, ToolHandler> = {};
  for (const tool of replayFixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const tools = new InMemoryToolRegistry(
    replayFixture.tools.map(({ result: _result, ...definition }) => definition) as ToolDefinition[],
    handlers,
  );
  const model = new FixtureModelProvider(replayFixture.modelResponses as ModelResponse[]);
  const trace: unknown[] = [];
  const agent = new QueryAgent({
    model,
    tools,
    workspace: replayFixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  const answer = await agent.answer(replayFixture.question, { intent: replayFixture.intent });
  const evalResult = validateQueryAnswer(answer);
  const evalIssues = evalResult.ok ? [] : [{ path: 'answer', message: evalResult.error }];
  const behavior = assertQueryBehavioralExpectations(answer, replayFixture.expectations);

  return {
    fixture: replayFixture.id,
    ok: evalResult.ok && behavior.ok,
    answer,
    eval: {
      name: 'query-answer-shape',
      ok: evalResult.ok,
      issues: evalIssues,
    },
    behavior,
    modelTurns: model.requests.length,
    trace,
  };
}

function assertQueryBehavioralExpectations(
  answer: string,
  expectations: QueryBehaviorExpectations | undefined,
) {
  const issues: { path: string; message: string }[] = [];
  if (!expectations) return { name: 'query-behavior', ok: true, issues };

  const answerText = answer.toLowerCase();
  for (const text of expectations.requiredAnswerText ?? []) {
    if (!answerText.includes(text.toLowerCase())) {
      issues.push({ path: 'expectations.requiredAnswerText', message: `expected answer containing "${text}"` });
    }
  }

  return { name: 'query-behavior', ok: issues.length === 0, issues };
}
