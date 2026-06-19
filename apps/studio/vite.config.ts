import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import {
  AnomalyMonitoringAgent,
  FixtureModelProvider as MonitoringFixtureModelProvider,
  validateAnomalies,
} from '@aptkit/agent-anomaly-monitoring';
import {
  DiagnosticInvestigationAgent,
  FixtureModelProvider as DiagnosticFixtureModelProvider,
  validateDiagnosis,
  type Anomaly as DiagnosticAnomaly,
  type Diagnosis as DiagnosticDiagnosis,
  type WorkspaceDescriptor as DiagnosticWorkspaceDescriptor,
} from '@aptkit/agent-diagnostic-investigation';
import {
  FixtureModelProvider as QueryFixtureModelProvider,
  QueryAgent,
  validateQueryAnswer,
  type Intent as QueryIntent,
  type WorkspaceDescriptor as QueryWorkspaceDescriptor,
} from '@aptkit/agent-query';
import { RecommendationAgent, FixtureModelProvider } from '@aptkit/agent-recommendation';
import {
  FixtureModelProvider as RubricImprovementFixtureModelProvider,
  RubricImprovementAgent,
  validateRubricImprovementResult,
  type RubricDefinition,
  type RubricImprovementResult,
} from '@aptkit/agent-rubric-improvement';
import {
  assertCapabilityReplayArtifactShape,
  assertDiagnosticReplayArtifactShape,
  assertMonitoringReplayArtifactShape,
  assertQueryReplayArtifactShape,
  assertRecommendationShape,
  assertReplayArtifactShape,
  evaluateStructuralDiff,
  scoreDetections,
  type StructuralDiffRule,
} from '@aptkit/evals';
import { AnthropicModelProvider } from '@aptkit/provider-anthropic';
import { FallbackModelProvider } from '@aptkit/provider-fallback';
import { OpenAIModelProvider } from '@aptkit/provider-openai';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import { encodeNdjsonRecord, estimateCost, isCapabilityEvent, modelTurnCount, summarizeUsage } from '@aptkit/runtime';
import type { CapabilityEvent, CostEstimate, ModelProvider, ModelResponse } from '@aptkit/runtime';
import type { Anomaly, Diagnosis, Recommendation, WorkspaceDescriptor } from '@aptkit/agent-recommendation';
import type { Anomaly as MonitoringAnomaly, WorkspaceDescriptor as MonitoringWorkspaceDescriptor } from '@aptkit/agent-anomaly-monitoring';
import monitoringFixture from '../../packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json';
import diagnosticFixture from '../../packages/agents/diagnostic-investigation/fixtures/sp-revenue-diagnostic.json';
import queryFixture from '../../packages/agents/query/fixtures/revenue-by-state-query.json';
import rubricImprovementFixture from '../../packages/agents/rubric-improvement/fixtures/brief-quality-actionability.json';
import electronicsSpikeFixture from '../../packages/agents/recommendation/fixtures/electronics-spike.json';
import spRevenueDropFixture from '../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
import voucherDropoffFixture from '../../packages/agents/recommendation/fixtures/voucher-dropoff.json';

type ReplayMode = 'fixture' | 'anthropic' | 'openai';

type MonitoringReplayMode = 'fixture' | 'openai';

type DiagnosticReplayMode = 'fixture' | 'openai';

type QueryReplayMode = 'fixture' | 'openai';

type RubricImprovementReplayMode = 'fixture' | 'openai';

type FixtureTool = ToolDefinition & { result: unknown };

type RecommendationFixture = {
  id: string;
  description: string;
  workspace: WorkspaceDescriptor;
  anomaly: Anomaly;
  diagnosis: Diagnosis;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
  expectations?: BehavioralExpectations;
  promotion?: {
    sourceArtifact?: string;
    sourceProvider?: { id?: string; model?: string };
    promotedAt?: string;
  };
};

type MonitoringFixture = {
  id: string;
  description: string;
  workspace: MonitoringWorkspaceDescriptor;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
  expectations?: MonitoringBehaviorExpectations;
  promotion?: {
    sourceArtifact?: string;
    sourceProvider?: { id?: string; model?: string };
    promotedAt?: string;
  };
};

type DiagnosticFixture = {
  id: string;
  description: string;
  workspace: DiagnosticWorkspaceDescriptor;
  anomaly: DiagnosticAnomaly;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
  expectations?: DiagnosticBehaviorExpectations;
  promotion?: {
    sourceArtifact?: string;
    sourceProvider?: { id?: string; model?: string };
    promotedAt?: string;
  };
};

type QueryFixture = {
  id: string;
  description: string;
  question: string;
  intent: QueryIntent;
  workspace: QueryWorkspaceDescriptor;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
  expectations?: QueryBehaviorExpectations;
  promotion?: {
    sourceArtifact?: string;
    sourceProvider?: { id?: string; model?: string };
    promotedAt?: string;
  };
};

type RubricImprovementFixture = {
  id: string;
  description: string;
  rubric: RubricDefinition;
  subject: string;
  context: Record<string, string>;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
};

type BehavioralExpectations = {
  requiredFeatures?: string[];
  requiredText?: string[];
};

type MonitoringBehaviorExpectations = {
  minAnomalyCount?: number;
  requiredCategories?: string[];
  requiredMetrics?: string[];
  requiredScopes?: string[];
  requiredSeverities?: string[];
};

type DiagnosticBehaviorExpectations = {
  requiredEvidenceText?: string[];
  requiredSupportedHypothesisText?: string[];
};

type QueryBehaviorExpectations = {
  requiredAnswerText?: string[];
};

type TraceRunOptions = {
  onEvent?: (event: CapabilityEvent) => void;
};

const fixtures = [
  spRevenueDropFixture,
  electronicsSpikeFixture,
  voucherDropoffFixture,
] as RecommendationFixture[];

const monitoringFixtures = [
  monitoringFixture,
] as MonitoringFixture[];

const diagnosticFixtures = [
  diagnosticFixture,
] as DiagnosticFixture[];

const queryFixtures = [
  queryFixture,
] as QueryFixture[];

const rubricImprovementFixtures = [
  rubricImprovementFixture,
] as RubricImprovementFixture[];

export default defineConfig(({ mode }) => {
  const env = loadStudioEnv(mode);

  return {
    plugins: [
      react(),
      {
        name: 'aptkit-studio-api',
        configureServer(server) {
          server.middlewares.use('/api/model-status', (_req, res) => {
            sendJson(res, {
              providers: {
                fixture: { available: true, model: 'fixture-model' },
                anthropic: {
                  available: Boolean(env.ANTHROPIC_API_KEY),
                  model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
                },
                openai: {
                  available: Boolean(env.OPENAI_API_KEY),
                  model: env.OPENAI_MODEL ?? 'gpt-4.1',
                },
              },
            });
          });

          server.middlewares.use('/api/promoted-fixtures', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              sendJson(res, { fixtures: await listPromotedFixtureSummaries() });
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/promoted-monitoring-fixtures', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              sendJson(res, { fixtures: await listPromotedMonitoringFixtureSummaries() });
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/promoted-diagnostic-fixtures', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              sendJson(res, { fixtures: await listPromotedDiagnosticFixtureSummaries() });
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/promoted-query-fixtures', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              sendJson(res, { fixtures: await listPromotedQueryFixtureSummaries() });
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/monitoring/replays/promote', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const artifactPath = resolveReplayPath(body.path);
              const result = await promoteMonitoringReplayArtifact(artifactPath);
              sendJson(res, result);
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/diagnostic/replays/promote', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const artifactPath = resolveReplayPath(body.path);
              const result = await promoteDiagnosticReplayArtifact(artifactPath);
              sendJson(res, result);
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/query/replays/promote', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const artifactPath = resolveReplayPath(body.path);
              const result = await promoteQueryReplayArtifact(artifactPath);
              sendJson(res, result);
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/replays/promote', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const artifactPath = resolveReplayPath(body.path);
              const result = await promoteReplayArtifact(artifactPath);
              sendJson(res, result);
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/replays', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              sendJson(res, { replays: await listReplaySummaries() });
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/replay/save', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const artifact = normalizeReplayArtifact(body.artifact);
              const outDir = resolve(workspaceRoot(), 'artifacts/replays');
              await mkdir(outDir, { recursive: true });
              const path = join(outDir, `${formatTimestamp(new Date(artifact.createdAt))}-${slugify(artifact.fixture.id)}-${slugify(artifact.provider.id)}-studio.json`);
              await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
              sendJson(res, { path: relativeFromWorkspace(path) });
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/stream/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            await streamReplayResponse(req, res, async (body, onEvent) => {
              const fixture = fixtures.find((candidate) => candidate.id === body.fixtureId) ?? fixtures[0];
              return runReplay(fixture, parseMode(body.mode), { onEvent });
            });
          });

          server.middlewares.use('/api/stream/monitoring/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            await streamReplayResponse(req, res, async (body, onEvent) => {
              const fixture = monitoringFixtures.find((candidate) => candidate.id === body.fixtureId) ?? monitoringFixtures[0];
              return runMonitoringReplay(fixture, parseMonitoringMode(body.mode), { onEvent });
            });
          });

          server.middlewares.use('/api/stream/diagnostic/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            await streamReplayResponse(req, res, async (body, onEvent) => {
              const fixture = diagnosticFixtures.find((candidate) => candidate.id === body.fixtureId) ?? diagnosticFixtures[0];
              return runDiagnosticReplay(fixture, parseDiagnosticMode(body.mode), { onEvent });
            });
          });

          server.middlewares.use('/api/stream/query/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            await streamReplayResponse(req, res, async (body, onEvent) => {
              const fixture = queryFixtures.find((candidate) => candidate.id === body.fixtureId) ?? queryFixtures[0];
              return runQueryReplay(fixture, parseQueryMode(body.mode), { onEvent });
            });
          });

          server.middlewares.use('/api/stream/rubric-improvement/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            await streamReplayResponse(req, res, async (body, onEvent) => {
              const fixture = rubricImprovementFixtures.find((candidate) => candidate.id === body.fixtureId) ?? rubricImprovementFixtures[0];
              return runRubricImprovementReplay(fixture, parseRubricImprovementMode(body.mode), { onEvent });
            });
          });

          server.middlewares.use('/api/monitoring/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const fixture = monitoringFixtures.find((candidate) => candidate.id === body.fixtureId) ?? monitoringFixtures[0];
              const mode = parseMonitoringMode(body.mode);
              const result = await runMonitoringReplay(fixture, mode);
              sendJson(res, result);
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/diagnostic/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const fixture = diagnosticFixtures.find((candidate) => candidate.id === body.fixtureId) ?? diagnosticFixtures[0];
              const mode = parseDiagnosticMode(body.mode);
              const result = await runDiagnosticReplay(fixture, mode);
              sendJson(res, result);
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/query/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const fixture = queryFixtures.find((candidate) => candidate.id === body.fixtureId) ?? queryFixtures[0];
              const mode = parseQueryMode(body.mode);
              const result = await runQueryReplay(fixture, mode);
              sendJson(res, result);
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });

          server.middlewares.use('/api/replay', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              sendJson(res, { error: 'method not allowed' });
              return;
            }

            try {
              const body = await readJsonBody(req);
              const fixture = fixtures.find((candidate) => candidate.id === body.fixtureId) ?? fixtures[0];
              const mode = parseMode(body.mode);
              const result = await runReplay(fixture, mode);
              sendJson(res, result);
            } catch (error) {
              res.statusCode = 400;
              sendJson(res, { error: error instanceof Error ? error.message : String(error) });
            }
          });
        },
      },
    ],
  };
});

async function runReplay(fixture: RecommendationFixture, mode: ReplayMode, options: TraceRunOptions = {}) {
  const startedAt = Date.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const trace: CapabilityEvent[] = [];
  const traceSink = {
    emit: (event: CapabilityEvent) => {
      trace.push(event);
      options.onEvent?.(event);
    },
  };
  const model = createModelProvider(fixture, mode, traceSink);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const agent = new RecommendationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    idGenerator: (() => {
      let index = 0;
      return () => `${fixture.id}-${mode}-${++index}`;
    })(),
    trace: traceSink,
  });

  const recommendations = await agent.propose(fixture.anomaly, fixture.diagnosis);
  const evalResult = assertRecommendationShape(recommendations);

  return {
    fixture: fixture.id,
    fixtureDescription: fixture.description,
    mode,
    recommendations,
    trace,
    eval: evalResult,
    modelTurns: modelTurnCount(trace),
    durationMs: Date.now() - startedAt,
  };
}

async function runMonitoringReplay(fixture: MonitoringFixture, mode: MonitoringReplayMode, options: TraceRunOptions = {}) {
  const startedAt = Date.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const trace: CapabilityEvent[] = [];
  const traceSink = {
    emit: (event: CapabilityEvent) => {
      trace.push(event);
      options.onEvent?.(event);
    },
  };
  const model = createMonitoringModelProvider(fixture, mode, traceSink);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const agent = new AnomalyMonitoringAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: traceSink,
  });

  const anomalies = await agent.scan();
  const validation = validateAnomalies(anomalies);
  const issues = validation.ok ? [] : [{ path: 'anomalies', message: validation.error }];

  return {
    fixture: fixture.id,
    fixtureDescription: fixture.description,
    mode,
    anomalies: anomalies as MonitoringAnomaly[],
    trace,
    eval: {
      name: 'anomaly-shape',
      ok: validation.ok,
      issues,
    },
    modelTurns: modelTurnCount(trace),
    durationMs: Date.now() - startedAt,
  };
}

async function runDiagnosticReplay(fixture: DiagnosticFixture, mode: DiagnosticReplayMode, options: TraceRunOptions = {}) {
  const startedAt = Date.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const trace: CapabilityEvent[] = [];
  const traceSink = {
    emit: (event: CapabilityEvent) => {
      trace.push(event);
      options.onEvent?.(event);
    },
  };
  const model = createDiagnosticModelProvider(fixture, mode, traceSink);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const agent = new DiagnosticInvestigationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: traceSink,
  });

  const diagnosis = await agent.investigate(fixture.anomaly) as DiagnosticDiagnosis;
  const validation = validateDiagnosis(diagnosis);
  const issues = validation.ok ? [] : [{ path: 'diagnosis', message: validation.error }];

  return {
    fixture: fixture.id,
    fixtureDescription: fixture.description,
    mode,
    diagnosis,
    trace,
    eval: {
      name: 'diagnosis-shape',
      ok: validation.ok,
      issues,
    },
    modelTurns: modelTurnCount(trace),
    durationMs: Date.now() - startedAt,
  };
}

async function runQueryReplay(fixture: QueryFixture, mode: QueryReplayMode, options: TraceRunOptions = {}) {
  const startedAt = Date.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const trace: CapabilityEvent[] = [];
  const traceSink = {
    emit: (event: CapabilityEvent) => {
      trace.push(event);
      options.onEvent?.(event);
    },
  };
  const model = createQueryModelProvider(fixture, mode, traceSink);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const agent = new QueryAgent({
    model,
    tools,
    workspace: fixture.workspace,
    trace: traceSink,
  });

  const answer = await agent.answer(fixture.question, { intent: fixture.intent });
  const validation = validateQueryAnswer(answer);
  const issues = validation.ok ? [] : [{ path: 'answer', message: validation.error }];

  return {
    fixture: fixture.id,
    fixtureDescription: fixture.description,
    mode,
    question: fixture.question,
    intent: fixture.intent,
    answer,
    trace,
    eval: {
      name: 'query-answer-shape',
      ok: validation.ok,
      issues,
    },
    modelTurns: modelTurnCount(trace),
    durationMs: Date.now() - startedAt,
  };
}

async function runRubricImprovementReplay(
  fixture: RubricImprovementFixture,
  mode: RubricImprovementReplayMode,
  options: TraceRunOptions = {},
) {
  const startedAt = Date.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const trace: CapabilityEvent[] = [];
  const traceSink = {
    emit: (event: CapabilityEvent) => {
      trace.push(event);
      options.onEvent?.(event);
    },
  };
  const model = createRubricImprovementModelProvider(fixture, mode, traceSink);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const agent = new RubricImprovementAgent({
    model,
    tools,
    rubric: fixture.rubric,
    trace: traceSink,
  });

  const result = await agent.improve({ subject: fixture.subject, context: fixture.context }) as RubricImprovementResult;
  const validation = validateRubricImprovementResult(fixture.rubric)(result);
  const issues = validation.ok ? [] : [{ path: 'result', message: validation.error }];

  return {
    fixture: fixture.id,
    fixtureDescription: fixture.description,
    mode,
    result,
    trace,
    eval: {
      name: 'rubric-improvement-shape',
      ok: validation.ok,
      issues,
    },
    modelTurns: modelTurnCount(trace),
    durationMs: Date.now() - startedAt,
  };
}

function createModelProvider(
  fixture: RecommendationFixture,
  mode: ReplayMode,
  trace: { emit(event: CapabilityEvent): void },
): ModelProvider {
  if (mode === 'fixture') return new FixtureModelProvider(fixture.modelResponses);
  if (mode === 'anthropic') {
    return providerWithConfiguredFallback(requireAnthropicProvider(), [configuredOpenAIProvider()], 'recommendation-agent', trace);
  }
  return providerWithConfiguredFallback(requireOpenAIProvider(), [configuredAnthropicProvider()], 'recommendation-agent', trace);
}

function createMonitoringModelProvider(
  fixture: MonitoringFixture,
  mode: MonitoringReplayMode,
  trace: { emit(event: CapabilityEvent): void },
): ModelProvider {
  if (mode === 'fixture') return new MonitoringFixtureModelProvider(fixture.modelResponses);
  return providerWithConfiguredFallback(requireOpenAIProvider(), [configuredAnthropicProvider()], 'anomaly-monitoring-agent', trace);
}

function createDiagnosticModelProvider(
  fixture: DiagnosticFixture,
  mode: DiagnosticReplayMode,
  trace: { emit(event: CapabilityEvent): void },
): ModelProvider {
  if (mode === 'fixture') return new DiagnosticFixtureModelProvider(fixture.modelResponses);
  return providerWithConfiguredFallback(requireOpenAIProvider(), [configuredAnthropicProvider()], 'diagnostic-investigation-agent', trace);
}

function createQueryModelProvider(
  fixture: QueryFixture,
  mode: QueryReplayMode,
  trace: { emit(event: CapabilityEvent): void },
): ModelProvider {
  if (mode === 'fixture') return new QueryFixtureModelProvider(fixture.modelResponses);
  return providerWithConfiguredFallback(requireOpenAIProvider(), [configuredAnthropicProvider()], 'query-agent', trace);
}

function createRubricImprovementModelProvider(
  fixture: RubricImprovementFixture,
  mode: RubricImprovementReplayMode,
  trace: { emit(event: CapabilityEvent): void },
): ModelProvider {
  if (mode === 'fixture') return new RubricImprovementFixtureModelProvider(fixture.modelResponses);
  return providerWithConfiguredFallback(requireOpenAIProvider(), [configuredAnthropicProvider()], 'rubric-improvement-agent', trace);
}

function requireOpenAIProvider(): ModelProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAIModelProvider({ apiKey, model: process.env.OPENAI_MODEL });
}

function requireAnthropicProvider(): ModelProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  return new AnthropicModelProvider({ apiKey, model: process.env.ANTHROPIC_MODEL });
}

function configuredOpenAIProvider(): ModelProvider | undefined {
  return process.env.OPENAI_API_KEY ? new OpenAIModelProvider({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }) : undefined;
}

function configuredAnthropicProvider(): ModelProvider | undefined {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicModelProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL }) : undefined;
}

function providerWithConfiguredFallback(
  primary: ModelProvider,
  candidates: readonly (ModelProvider | undefined)[],
  capabilityId: string,
  trace: { emit(event: CapabilityEvent): void },
): ModelProvider {
  const providers = [primary, ...candidates.filter((provider): provider is ModelProvider => Boolean(provider) && provider.id !== primary.id)];
  if (providers.length === 1) return primary;
  return new FallbackModelProvider({ providers, capabilityId, trace });
}

function loadStudioEnv(mode: string): NodeJS.ProcessEnv {
  const studioDir = dirname(fileURLToPath(import.meta.url));
  const root = workspaceRoot();
  const env = {
    ...loadEnv(mode, root, ''),
    ...loadEnv(mode, studioDir, ''),
    ...process.env,
  };

  setProcessEnv('OPENAI_API_KEY', env.OPENAI_API_KEY);
  setProcessEnv('OPENAI_MODEL', env.OPENAI_MODEL);
  setProcessEnv('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
  setProcessEnv('ANTHROPIC_MODEL', env.ANTHROPIC_MODEL);

  return env;
}

function workspaceRoot(): string {
  const studioDir = dirname(fileURLToPath(import.meta.url));
  return resolve(studioDir, '../..');
}

function setProcessEnv(name: string, value: string | undefined) {
  if (value === undefined) return;
  process.env[name] = value;
}

function parseMode(value: unknown): ReplayMode {
  if (value === 'fixture' || value === 'anthropic' || value === 'openai') return value;
  return 'fixture';
}

function parseMonitoringMode(value: unknown): MonitoringReplayMode {
  if (value === 'openai') return 'openai';
  return 'fixture';
}

function parseDiagnosticMode(value: unknown): DiagnosticReplayMode {
  if (value === 'openai') return 'openai';
  return 'fixture';
}

function parseQueryMode(value: unknown): QueryReplayMode {
  if (value === 'openai') return 'openai';
  return 'fixture';
}

function parseRubricImprovementMode(value: unknown): RubricImprovementReplayMode {
  if (value === 'openai') return 'openai';
  return 'fixture';
}

function sendJson(res: { setHeader(name: string, value: string): void; end(body: string): void }, body: unknown) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function streamReplayResponse<T>(
  req: NodeJS.ReadableStream,
  res: {
    setHeader(name: string, value: string): void;
    write(chunk: string): void;
    end(): void;
  },
  run: (
    body: { fixtureId?: string; mode?: unknown; artifact?: unknown; path?: unknown },
    onEvent: (event: CapabilityEvent) => void,
  ) => Promise<T>,
): Promise<void> {
  // Keep transport concerns in Studio while runtime owns the NDJSON record encoding.
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');

  try {
    const body = await readJsonBody(req);
    const result = await run(body, (event) => {
      res.write(encodeNdjsonRecord({ type: 'event', event }));
    });
    res.write(encodeNdjsonRecord({ type: 'result', result }));
  } catch (error) {
    res.write(encodeNdjsonRecord({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    res.end();
  }
}

function readJsonBody(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function listReplaySummaries() {
  const dir = resolve(workspaceRoot(), 'artifacts/replays');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }

  const summaries = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== '.json') continue;
    const path = join(dir, entry.name);
    const artifact = JSON.parse(await readFile(path, 'utf8'));
    const evaluation = assertCapabilityReplayArtifactShape(artifact);
    const usage = summarizeUnknownTraceUsage(artifact.trace);
    const costEstimate = parseCostEstimate(artifact.costEstimate)
      ?? estimateCost(String(artifact.provider?.id ?? ''), usage, String(artifact.provider?.model ?? ''));
    summaries.push({
      path: relativeFromWorkspace(path),
      capabilityId: typeof artifact.capabilityId === 'string' ? artifact.capabilityId : 'recommendation-agent',
      createdAt: typeof artifact.createdAt === 'string' ? artifact.createdAt : '',
      provider: artifact.provider,
      fixture: artifact.fixture,
      promptPackage: parsePromptPackageProvenance(artifact.promptPackage),
      evalOk: evaluation.ok,
      issues: evaluation.issues,
      recommendations: Array.isArray(artifact.recommendations) ? artifact.recommendations : [],
      recommendationCount: Array.isArray(artifact.recommendations) ? artifact.recommendations.length : 0,
      anomalies: Array.isArray(artifact.anomalies) ? artifact.anomalies : [],
      anomalyCount: Array.isArray(artifact.anomalies) ? artifact.anomalies.length : 0,
      diagnosis: isRecord(artifact.diagnosis) ? artifact.diagnosis : undefined,
      diagnosisPresent: isRecord(artifact.diagnosis),
      question: typeof artifact.question === 'string' ? artifact.question : undefined,
      intent: typeof artifact.intent === 'string' ? artifact.intent : undefined,
      answer: typeof artifact.answer === 'string' ? artifact.answer : '',
      answerPresent: typeof artifact.answer === 'string' && artifact.answer.trim().length > 0,
      durationMs: typeof artifact.durationMs === 'number' ? artifact.durationMs : 0,
      modelTurns: typeof artifact.modelTurns === 'number' ? artifact.modelTurns : 0,
      usage,
      ...(costEstimate ? { costEstimate } : {}),
    });
  }

  return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function listPromotedFixtureSummaries() {
  const dir = resolve(workspaceRoot(), 'packages/agents/recommendation/fixtures/promoted');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }

  const summaries = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== '.json') continue;
    const path = join(dir, entry.name);
    const fixture = JSON.parse(await readFile(path, 'utf8')) as RecommendationFixture;
    const replay = await runReplay(fixture, 'fixture');
    const behavior = assertBehavioralExpectations(replay.recommendations, fixture.expectations);
    const usage = summarizeUsage(replay.trace);
    const costEstimate = estimateCost(
      fixture.promotion?.sourceProvider?.id ?? 'fixture',
      usage,
      fixture.promotion?.sourceProvider?.model ?? '',
    );
    summaries.push({
      path: relativeFromWorkspace(path),
      id: fixture.id,
      description: fixture.description,
      promotion: fixture.promotion,
      expectations: fixture.expectations,
      evalOk: replay.eval.ok,
      behaviorOk: behavior.ok,
      ok: replay.eval.ok && behavior.ok,
      issues: [
        ...replay.eval.issues.map((issue) => ({ ...issue, source: replay.eval.name })),
        ...behavior.issues.map((issue) => ({ ...issue, source: behavior.name })),
      ],
      recommendationCount: replay.recommendations.length,
      modelTurns: replay.modelTurns,
      usage,
      ...(costEstimate ? { costEstimate } : {}),
    });
  }

  return summaries.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
}

async function listPromotedMonitoringFixtureSummaries() {
  const dir = resolve(workspaceRoot(), 'packages/agents/anomaly-monitoring/fixtures/promoted');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }

  const summaries = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== '.json') continue;
    const path = join(dir, entry.name);
    const fixture = JSON.parse(await readFile(path, 'utf8')) as MonitoringFixture;
    const replay = await runMonitoringReplay(fixture, 'fixture');
    const behavior = assertMonitoringBehavioralExpectations(replay.anomalies, fixture.expectations);
    const usage = summarizeUsage(replay.trace);
    const costEstimate = estimateCost(
      fixture.promotion?.sourceProvider?.id ?? 'fixture',
      usage,
      fixture.promotion?.sourceProvider?.model ?? '',
    );
    summaries.push({
      path: relativeFromWorkspace(path),
      id: fixture.id,
      description: fixture.description,
      promotion: fixture.promotion,
      expectations: fixture.expectations,
      evalOk: replay.eval.ok,
      behaviorOk: behavior.ok,
      ok: replay.eval.ok && behavior.ok,
      issues: [
        ...replay.eval.issues.map((issue) => ({ ...issue, source: replay.eval.name })),
        ...behavior.issues.map((issue) => ({ ...issue, source: behavior.name })),
      ],
      anomalyCount: replay.anomalies.length,
      modelTurns: replay.modelTurns,
      usage,
      ...(costEstimate ? { costEstimate } : {}),
    });
  }

  return summaries.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
}

async function listPromotedDiagnosticFixtureSummaries() {
  const dir = resolve(workspaceRoot(), 'packages/agents/diagnostic-investigation/fixtures/promoted');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }

  const summaries = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== '.json') continue;
    const path = join(dir, entry.name);
    const fixture = JSON.parse(await readFile(path, 'utf8')) as DiagnosticFixture;
    const replay = await runDiagnosticReplay(fixture, 'fixture');
    const behavior = assertDiagnosticBehavioralExpectations(replay.diagnosis, fixture.expectations);
    const usage = summarizeUsage(replay.trace);
    const costEstimate = estimateCost(
      fixture.promotion?.sourceProvider?.id ?? 'fixture',
      usage,
      fixture.promotion?.sourceProvider?.model ?? '',
    );
    summaries.push({
      path: relativeFromWorkspace(path),
      id: fixture.id,
      description: fixture.description,
      promotion: fixture.promotion,
      expectations: fixture.expectations,
      evalOk: replay.eval.ok,
      behaviorOk: behavior.ok,
      ok: replay.eval.ok && behavior.ok,
      issues: [
        ...replay.eval.issues.map((issue) => ({ ...issue, source: replay.eval.name })),
        ...behavior.issues.map((issue) => ({ ...issue, source: behavior.name })),
      ],
      diagnosisPresent: Boolean(replay.diagnosis),
      modelTurns: replay.modelTurns,
      usage,
      ...(costEstimate ? { costEstimate } : {}),
    });
  }

  return summaries.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
}

async function listPromotedQueryFixtureSummaries() {
  const dir = resolve(workspaceRoot(), 'packages/agents/query/fixtures/promoted');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }

  const summaries = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== '.json') continue;
    const path = join(dir, entry.name);
    const fixture = JSON.parse(await readFile(path, 'utf8')) as QueryFixture;
    const replay = await runQueryReplay(fixture, 'fixture');
    const behavior = assertQueryBehavioralExpectations(replay.answer, fixture.expectations);
    const usage = summarizeUsage(replay.trace);
    const costEstimate = estimateCost(
      fixture.promotion?.sourceProvider?.id ?? 'fixture',
      usage,
      fixture.promotion?.sourceProvider?.model ?? '',
    );
    summaries.push({
      path: relativeFromWorkspace(path),
      id: fixture.id,
      description: fixture.description,
      promotion: fixture.promotion,
      expectations: fixture.expectations,
      evalOk: replay.eval.ok,
      behaviorOk: behavior.ok,
      ok: replay.eval.ok && behavior.ok,
      issues: [
        ...replay.eval.issues.map((issue) => ({ ...issue, source: replay.eval.name })),
        ...behavior.issues.map((issue) => ({ ...issue, source: behavior.name })),
      ],
      answerPresent: replay.answer.trim().length > 0,
      modelTurns: replay.modelTurns,
      usage,
      ...(costEstimate ? { costEstimate } : {}),
    });
  }

  return summaries.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
}

function assertBehavioralExpectations(
  recommendations: Recommendation[],
  expectations: BehavioralExpectations | undefined,
) {
  if (!expectations) return { name: 'recommendation-behavior', ok: true, issues: [] };
  const rules: StructuralDiffRule[] = [
    ...(expectations.requiredFeatures ?? []).map((feature): StructuralDiffRule => ({
      type: 'arrayIncludes',
      path: '',
      itemPath: 'bloomreachFeature',
      value: feature,
      message: `expected at least one recommendation with bloomreachFeature=${feature}`,
    })),
    ...(expectations.requiredText ?? []).map((text): StructuralDiffRule => ({
      type: 'containsText',
      path: '',
      text,
      message: `expected recommendation text to include "${text}"`,
    })),
  ];
  return { name: 'recommendation-behavior', ...evaluateStructuralDiff(recommendations, rules) };
}

function assertMonitoringBehavioralExpectations(
  anomalies: MonitoringAnomaly[],
  expectations: MonitoringBehaviorExpectations | undefined,
) {
  if (!expectations) return { name: 'monitoring-behavior', ok: true, issues: [] };
  const result = scoreDetections(anomalies, {
    minCount: expectations.minAnomalyCount,
    requiredCategories: expectations.requiredCategories,
    requiredMetrics: expectations.requiredMetrics,
    requiredScopes: expectations.requiredScopes,
    requiredSeverities: expectations.requiredSeverities,
  });
  return { name: 'monitoring-behavior', ok: result.ok, issues: result.issues };
}

function assertDiagnosticBehavioralExpectations(
  diagnosis: DiagnosticDiagnosis,
  expectations: DiagnosticBehaviorExpectations | undefined,
) {
  if (!expectations) return { name: 'diagnostic-behavior', ok: true, issues: [] };
  const supportedHypotheses = diagnosis.hypothesesConsidered.filter((hypothesis) => hypothesis.supported);
  const evidenceResult = evaluateStructuralDiff(diagnosis, (expectations.requiredEvidenceText ?? []).map((text) => ({
    type: 'containsText',
    path: 'evidence',
    text,
    message: `expected evidence containing "${text}"`,
  })));
  const hypothesisResult = evaluateStructuralDiff(supportedHypotheses, (expectations.requiredSupportedHypothesisText ?? []).map((text) => ({
    type: 'containsText',
    path: '',
    text,
    message: `expected supported hypothesis containing "${text}"`,
  })));
  const issues = [...evidenceResult.issues, ...hypothesisResult.issues];
  return { name: 'diagnostic-behavior', ok: issues.length === 0, issues };
}

function assertQueryBehavioralExpectations(
  answer: string,
  expectations: QueryBehaviorExpectations | undefined,
) {
  if (!expectations) return { name: 'query-behavior', ok: true, issues: [] };
  const rules = (expectations.requiredAnswerText ?? []).map((text): StructuralDiffRule => ({
    type: 'containsText',
    path: '',
    text,
    message: `expected answer containing "${text}"`,
  }));
  return { name: 'query-behavior', ...evaluateStructuralDiff(answer, rules) };
}

async function promoteReplayArtifact(artifactPath: string) {
  return promoteCapabilityReplayArtifact(artifactPath, {
    label: 'recommendation',
    outDir: 'packages/agents/recommendation/fixtures/promoted',
    validate: assertReplayArtifactShape,
    output: (artifact) => stripRecommendationIds(artifact.recommendations),
    result: (artifact) => ({
      recommendationCount: Array.isArray(artifact.recommendations) ? artifact.recommendations.length : 0,
    }),
  });
}

async function promoteMonitoringReplayArtifact(artifactPath: string) {
  return promoteCapabilityReplayArtifact(artifactPath, {
    label: 'monitoring',
    outDir: 'packages/agents/anomaly-monitoring/fixtures/promoted',
    validate: assertMonitoringReplayArtifactShape,
    output: (artifact) => Array.isArray(artifact.anomalies) ? artifact.anomalies : [],
    expectations: (artifact) => monitoringExpectationsFromAnomalies(Array.isArray(artifact.anomalies) ? artifact.anomalies : []),
    result: (artifact) => ({
      anomalyCount: Array.isArray(artifact.anomalies) ? artifact.anomalies.length : 0,
    }),
  });
}

async function promoteDiagnosticReplayArtifact(artifactPath: string) {
  return promoteCapabilityReplayArtifact(artifactPath, {
    label: 'diagnostic',
    outDir: 'packages/agents/diagnostic-investigation/fixtures/promoted',
    validate: assertDiagnosticReplayArtifactShape,
    output: (artifact) => isRecord(artifact.diagnosis) ? artifact.diagnosis : {},
    expectations: (artifact) => diagnosticExpectationsFromDiagnosis(isRecord(artifact.diagnosis) ? artifact.diagnosis as DiagnosticDiagnosis : undefined),
    result: (artifact) => ({
      diagnosisPresent: isRecord(artifact.diagnosis),
    }),
  });
}

async function promoteQueryReplayArtifact(artifactPath: string) {
  return promoteCapabilityReplayArtifact(artifactPath, {
    label: 'query',
    outDir: 'packages/agents/query/fixtures/promoted',
    validate: assertQueryReplayArtifactShape,
    output: (artifact) => typeof artifact.answer === 'string' ? artifact.answer : '',
    responseText: (artifact) => typeof artifact.answer === 'string' ? artifact.answer : '',
    expectations: (artifact) => queryExpectationsFromAnswer(typeof artifact.answer === 'string' ? artifact.answer : ''),
    result: (artifact) => ({
      answerPresent: typeof artifact.answer === 'string' && artifact.answer.trim().length > 0,
    }),
  });
}

type PromotionAdapter = {
  label: string;
  outDir: string;
  validate: (artifact: unknown) => { ok: boolean; issues: { path: string; message: string }[] };
  output: (artifact: Record<string, unknown>) => unknown;
  responseText?: (artifact: Record<string, unknown>) => string;
  expectations?: (artifact: Record<string, unknown>) => unknown;
  result: (artifact: Record<string, unknown>) => Record<string, unknown>;
};

async function promoteCapabilityReplayArtifact(artifactPath: string, adapter: PromotionAdapter) {
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  const evaluation = adapter.validate(artifact);
  if (!evaluation.ok) {
    throw new Error(`${adapter.label} replay artifact is not promotable: ${evaluation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
  if (!isRecord(artifact) || !isRecord(artifact.fixture) || !isRecord(artifact.provider)) {
    throw new Error(`${adapter.label} replay artifact is malformed`);
  }

  const sourceFixturePath = resolve(workspaceRoot(), artifact.fixture.path);
  const sourceFixture = JSON.parse(await readFile(sourceFixturePath, 'utf8'));
  const providerId = artifact.provider.id;
  const promotedId = `${artifact.fixture.id}-${providerId}-promoted`;
  const usage = summarizeUnknownTraceUsage(artifact.trace);
  const promoted = {
    ...sourceFixture,
    id: promotedId,
    description: [
      `Promoted deterministic ${adapter.label} fixture from ${providerId} replay artifact.`,
      `Source fixture: ${artifact.fixture.id}.`,
      `Replay created at: ${artifact.createdAt}.`,
    ].join(' '),
    modelResponses: [
      {
        content: [
          {
            type: 'text',
            text: adapter.responseText
              ? asciiString(adapter.responseText(artifact))
              : `\`\`\`json\n${JSON.stringify(toAscii(adapter.output(artifact)), null, 2)}\n\`\`\``,
          },
        ],
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimated: true,
        },
        model: `promoted-${providerId}-replay`,
      },
    ],
    ...(adapter.expectations ? { expectations: adapter.expectations(artifact) } : {}),
    promotion: {
      sourceArtifact: relativeFromWorkspace(artifactPath),
      sourceProvider: artifact.provider,
      promotedAt: new Date().toISOString(),
      note: `This fixture captures the final ${adapter.label} replay answer deterministically; it does not reconstruct the live provider tool loop.`,
    },
  };

  const artifactDate = new Date(artifact.createdAt);
  const outDir = resolve(workspaceRoot(), adapter.outDir);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${slugify(promotedId)}-${formatDateForFilename(artifactDate)}.json`);
  await writeFile(outPath, `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');

  return {
    path: relativeFromWorkspace(outPath),
    id: promoted.id,
    sourceArtifact: promoted.promotion.sourceArtifact,
    ...adapter.result(artifact),
  };
}

function monitoringExpectationsFromAnomalies(anomalies: MonitoringAnomaly[]): MonitoringBehaviorExpectations {
  return {
    minAnomalyCount: anomalies.length,
    requiredCategories: uniqueStrings(anomalies.map((anomaly) => anomaly.category).filter((value): value is string => Boolean(value))),
    requiredMetrics: uniqueStrings(anomalies.map((anomaly) => anomaly.metric)),
    requiredScopes: uniqueStrings(anomalies.flatMap((anomaly) => anomaly.scope)),
    requiredSeverities: uniqueStrings(anomalies.map((anomaly) => anomaly.severity)),
  };
}

function diagnosticExpectationsFromDiagnosis(diagnosis: DiagnosticDiagnosis | undefined): DiagnosticBehaviorExpectations {
  const evidence = diagnosis?.evidence ?? [];
  const supported = diagnosis?.hypothesesConsidered.find((hypothesis) => hypothesis.supported);
  return {
    requiredEvidenceText: evidence.slice(0, 3).map(expectationPhrase).filter(Boolean),
    requiredSupportedHypothesisText: supported ? [expectationPhrase(`${supported.hypothesis} ${supported.reasoning}`)].filter(Boolean) : [],
  };
}

function queryExpectationsFromAnswer(answer: string): QueryBehaviorExpectations {
  return {
    requiredAnswerText: answerExpectationPhrases(answer),
  };
}

function answerExpectationPhrases(answer: string): string[] {
  const candidates = [
    ...answer.matchAll(/\b[A-Z]{2}\b/g),
    ...answer.matchAll(/\bBRL\s+[0-9]+(?:,[0-9]{3})*/g),
  ].map((match) => match[0]);
  return uniqueStrings(candidates).slice(0, 6);
}

function expectationPhrase(value: string): string {
  const words = value
    .replace(/[^\w\s.%+-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 6).join(' ');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function resolveReplayPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('path must be a string');
  const root = workspaceRoot();
  const replayRoot = resolve(root, 'artifacts/replays');
  const path = resolve(root, value);
  if (!path.startsWith(`${replayRoot}/`) && path !== replayRoot) {
    throw new Error('path must be under artifacts/replays');
  }
  return path;
}

function stripRecommendationIds(recommendations: unknown): unknown[] {
  if (!Array.isArray(recommendations)) return [];
  return recommendations.map((recommendation) => {
    if (!isRecord(recommendation)) return recommendation;
    const { id: _id, ...idlessRecommendation } = recommendation;
    return idlessRecommendation;
  });
}

function toAscii(value: unknown): unknown {
  if (typeof value === 'string') return asciiString(value);
  if (Array.isArray(value)) return value.map(toAscii);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toAscii(child)]));
  }
  return value;
}

function asciiString(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s*[\u2013\u2014]\s*/g, ' - ')
    .replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function summarizeUnknownTraceUsage(trace: unknown) {
  const events = Array.isArray(trace) ? trace.filter(isCapabilityEvent) : [];
  return summarizeUsage(events);
}

function parseCostEstimate(value: unknown): CostEstimate | undefined {
  if (!isRecord(value)) return undefined;
  if (value.currency !== 'USD' || value.estimated !== true) return undefined;
  if (
    typeof value.inputCost !== 'number'
    || typeof value.outputCost !== 'number'
    || typeof value.totalCost !== 'number'
    || typeof value.inputUsdPerMillion !== 'number'
    || typeof value.outputUsdPerMillion !== 'number'
  ) {
    return undefined;
  }
  return value as CostEstimate;
}

function parsePromptPackageProvenance(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string'
    || typeof value.version !== 'string'
    || typeof value.capabilityId !== 'string'
    || typeof value.templateHash !== 'string'
    || typeof value.templateChars !== 'number'
    || typeof value.renderedHash !== 'string'
    || typeof value.renderedChars !== 'number'
  ) {
    return undefined;
  }
  return {
    id: value.id,
    version: value.version,
    capabilityId: value.capabilityId,
    templateHash: value.templateHash,
    templateChars: value.templateChars,
    renderedHash: value.renderedHash,
    renderedChars: value.renderedChars,
  };
}

function normalizeReplayArtifact(value: unknown): Record<string, unknown> & {
  createdAt: string;
  fixture: { id: string };
  provider: { id: string };
} {
  if (!isRecord(value)) throw new Error('artifact must be an object');
  if (value.schemaVersion !== 1) throw new Error('artifact schemaVersion must be 1');
  if (typeof value.createdAt !== 'string') throw new Error('artifact createdAt must be a string');
  if (!isRecord(value.fixture) || typeof value.fixture.id !== 'string') throw new Error('artifact fixture.id must be a string');
  if (!isRecord(value.provider) || typeof value.provider.id !== 'string') throw new Error('artifact provider.id must be a string');
  if (!Array.isArray(value.recommendations) && !Array.isArray(value.anomalies) && !isRecord(value.diagnosis) && typeof value.answer !== 'string') {
    throw new Error('artifact must include recommendations, anomalies, diagnosis, or answer');
  }
  if (!Array.isArray(value.trace)) throw new Error('artifact trace must be an array');
  return value as ReturnType<typeof normalizeReplayArtifact>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function formatDateForFilename(date: Date): string {
  if (Number.isNaN(date.getTime())) return 'unknown-date';
  return date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'replay';
}

function relativeFromWorkspace(path: string): string {
  const root = workspaceRoot();
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}
