import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import type { ModelResponse } from '@aptkit/runtime';
import { AnomalyMonitoringAgent, FixtureModelProvider, validateAnomalies, type Anomaly } from '../src/index.js';
import fixture from '../fixtures/sp-revenue-monitoring.json' with { type: 'json' };

type MonitoringFixture = typeof fixture & {
  expectations?: MonitoringBehaviorExpectations;
};

type MonitoringBehaviorExpectations = {
  minAnomalyCount?: number;
  requiredCategories?: string[];
  requiredMetrics?: string[];
  requiredScopes?: string[];
  requiredSeverities?: string[];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2];
  const result = await runFixtureReplay(fixturePath);
  console.log(JSON.stringify(result, null, 2));
}

export async function runFixtureReplay(path?: string) {
  const replayFixture = path
    ? JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8')) as MonitoringFixture
    : fixture as MonitoringFixture;

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
  const agent = new AnomalyMonitoringAgent({
    model,
    tools,
    workspace: replayFixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  const anomalies = await agent.scan();
  const evalResult = validateAnomalies(anomalies);
  const evalIssues = evalResult.ok ? [] : [{ path: 'anomalies', message: evalResult.error }];
  const behavior = assertMonitoringBehavioralExpectations(anomalies, replayFixture.expectations);

  return {
    fixture: replayFixture.id,
    ok: evalResult.ok && behavior.ok,
    anomalies,
    eval: {
      name: 'anomaly-shape',
      ok: evalResult.ok,
      issues: evalIssues,
    },
    behavior,
    modelTurns: model.requests.length,
    trace,
  };
}

function assertMonitoringBehavioralExpectations(
  anomalies: Anomaly[],
  expectations: MonitoringBehaviorExpectations | undefined,
) {
  const issues: { path: string; message: string }[] = [];
  if (!expectations) return { name: 'monitoring-behavior', ok: true, issues };

  const minAnomalyCount = expectations.minAnomalyCount ?? 0;
  if (anomalies.length < minAnomalyCount) {
    issues.push({
      path: 'expectations.minAnomalyCount',
      message: `expected at least ${minAnomalyCount} anomalies, got ${anomalies.length}`,
    });
  }

  for (const category of expectations.requiredCategories ?? []) {
    if (!anomalies.some((anomaly) => anomaly.category === category)) {
      issues.push({ path: 'expectations.requiredCategories', message: `expected category=${category}` });
    }
  }

  for (const metric of expectations.requiredMetrics ?? []) {
    if (!anomalies.some((anomaly) => anomaly.metric === metric)) {
      issues.push({ path: 'expectations.requiredMetrics', message: `expected metric=${metric}` });
    }
  }

  for (const scope of expectations.requiredScopes ?? []) {
    if (!anomalies.some((anomaly) => anomaly.scope.includes(scope))) {
      issues.push({ path: 'expectations.requiredScopes', message: `expected scope=${scope}` });
    }
  }

  for (const severity of expectations.requiredSeverities ?? []) {
    if (!anomalies.some((anomaly) => anomaly.severity === severity)) {
      issues.push({ path: 'expectations.requiredSeverities', message: `expected severity=${severity}` });
    }
  }

  return { name: 'monitoring-behavior', ok: issues.length === 0, issues };
}
