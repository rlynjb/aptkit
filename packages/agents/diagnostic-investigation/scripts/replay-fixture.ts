import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import {
  DiagnosticInvestigationAgent,
  FixtureModelProvider,
  validateDiagnosis,
  type Anomaly,
  type Diagnosis,
} from '../src/index.js';
import fixture from '../fixtures/sp-revenue-diagnostic.json' with { type: 'json' };

type FixtureTool = ToolDefinition & { result: unknown };

type DiagnosticFixture = typeof fixture & {
  tools: FixtureTool[];
  anomaly: Anomaly;
  expectations?: DiagnosticBehaviorExpectations;
};

type DiagnosticBehaviorExpectations = {
  requiredEvidenceText?: string[];
  requiredSupportedHypothesisText?: string[];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2];
  const result = await runFixtureReplay(fixturePath);
  console.log(JSON.stringify(result, null, 2));
}

export async function runFixtureReplay(path?: string) {
  const replayFixture = path
    ? JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8')) as DiagnosticFixture
    : fixture as DiagnosticFixture;

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
  const agent = new DiagnosticInvestigationAgent({
    model,
    tools,
    workspace: replayFixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  const diagnosis = await agent.investigate(replayFixture.anomaly);
  const evalResult = validateDiagnosis(diagnosis);
  const evalIssues = evalResult.ok ? [] : [{ path: 'diagnosis', message: evalResult.error }];
  const behavior = assertDiagnosticBehavioralExpectations(diagnosis, replayFixture.expectations);

  return {
    fixture: replayFixture.id,
    ok: evalResult.ok && behavior.ok,
    diagnosis,
    eval: {
      name: 'diagnosis-shape',
      ok: evalResult.ok,
      issues: evalIssues,
    },
    behavior,
    modelTurns: model.requests.length,
    trace,
  };
}

function assertDiagnosticBehavioralExpectations(
  diagnosis: Diagnosis,
  expectations: DiagnosticBehaviorExpectations | undefined,
) {
  const issues: { path: string; message: string }[] = [];
  if (!expectations) return { name: 'diagnostic-behavior', ok: true, issues };

  const evidenceText = diagnosis.evidence.join('\n').toLowerCase();
  for (const text of expectations.requiredEvidenceText ?? []) {
    if (!evidenceText.includes(text.toLowerCase())) {
      issues.push({ path: 'expectations.requiredEvidenceText', message: `expected evidence containing "${text}"` });
    }
  }

  const supportedText = diagnosis.hypothesesConsidered
    .filter((hypothesis) => hypothesis.supported)
    .map((hypothesis) => `${hypothesis.hypothesis}\n${hypothesis.reasoning}`)
    .join('\n')
    .toLowerCase();
  for (const text of expectations.requiredSupportedHypothesisText ?? []) {
    if (!supportedText.includes(text.toLowerCase())) {
      issues.push({ path: 'expectations.requiredSupportedHypothesisText', message: `expected supported hypothesis containing "${text}"` });
    }
  }

  return { name: 'diagnostic-behavior', ok: issues.length === 0, issues };
}
