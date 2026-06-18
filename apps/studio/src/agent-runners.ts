import { AnomalyMonitoringAgent, FixtureModelProvider as MonitoringFixtureModelProvider, validateAnomalies } from '@aptkit/agent-anomaly-monitoring';
import { DiagnosticInvestigationAgent, FixtureModelProvider as DiagnosticFixtureModelProvider, validateDiagnosis } from '@aptkit/agent-diagnostic-investigation';
import { FixtureModelProvider as QueryFixtureModelProvider, QueryAgent, validateQueryAnswer } from '@aptkit/agent-query';
import { RecommendationAgent, FixtureModelProvider } from '@aptkit/agent-recommendation';
import { assertRecommendationShape } from '@aptkit/evals';
import type { CapabilityEvent } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolHandler } from '@aptkit/tools';
import type { DiagnosticFixture, DiagnosticReplayResult, MonitoringFixture, MonitoringReplayResult, QueryFixture, QueryReplayResult, RecommendationFixture, ReplayResult } from './types';

export function runFixtureReplay(fixture: RecommendationFixture): Promise<ReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new FixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const idGenerator = (() => {
    let index = 0;
    return () => `${fixture.id}-studio-${++index}`;
  })();

  const agent = new RecommendationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    idGenerator,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.propose(fixture.anomaly, fixture.diagnosis).then((recommendations) => {
    const evalResult = assertRecommendationShape(recommendations);
    return {
      recommendations,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: evalResult.issues,
      evalIssues: evalResult.issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

export function runMonitoringFixtureReplay(fixture: MonitoringFixture): Promise<MonitoringReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new MonitoringFixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const agent = new AnomalyMonitoringAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.scan().then((anomalies) => {
    const evalResult = validateAnomalies(anomalies);
    const issues = evalResult.ok ? [] : [{ path: 'anomalies', message: evalResult.error }];
    return {
      anomalies,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: issues,
      evalIssues: issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

export function runDiagnosticFixtureReplay(fixture: DiagnosticFixture): Promise<DiagnosticReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new DiagnosticFixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const agent = new DiagnosticInvestigationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.investigate(fixture.anomaly).then((diagnosis) => {
    const evalResult = validateDiagnosis(diagnosis);
    const issues = evalResult.ok ? [] : [{ path: 'diagnosis', message: evalResult.error }];
    return {
      diagnosis,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: issues,
      evalIssues: issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

export function runQueryFixtureReplay(fixture: QueryFixture): Promise<QueryReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new QueryFixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const agent = new QueryAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.answer(fixture.question, { intent: fixture.intent }).then((answer) => {
    const evalResult = validateQueryAnswer(answer);
    const issues = evalResult.ok ? [] : [{ path: 'answer', message: evalResult.error }];
    return {
      answer,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: issues,
      evalIssues: issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}
