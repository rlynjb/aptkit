import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { RecommendationAgent, FixtureModelProvider } from '@aptkit/agent-recommendation';
import { assertRecommendationShape, assertReplayArtifactShape } from '@aptkit/evals';
import { AnthropicModelProvider } from '@aptkit/provider-anthropic';
import { OpenAIModelProvider } from '@aptkit/provider-openai';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import type { CapabilityEvent, ModelProvider, ModelResponse } from '@aptkit/runtime';
import type { Anomaly, Diagnosis, Recommendation, WorkspaceDescriptor } from '@aptkit/agent-recommendation';
import electronicsSpikeFixture from '../../packages/agents/recommendation/fixtures/electronics-spike.json';
import spRevenueDropFixture from '../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
import voucherDropoffFixture from '../../packages/agents/recommendation/fixtures/voucher-dropoff.json';

type ReplayMode = 'fixture' | 'anthropic' | 'openai';

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

type BehavioralExpectations = {
  requiredFeatures?: string[];
  requiredText?: string[];
};

const fixtures = [
  spRevenueDropFixture,
  electronicsSpikeFixture,
  voucherDropoffFixture,
] as RecommendationFixture[];

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

async function runReplay(fixture: RecommendationFixture, mode: ReplayMode) {
  const startedAt = Date.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = createModelProvider(fixture, mode);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const agent = new RecommendationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    idGenerator: (() => {
      let index = 0;
      return () => `${fixture.id}-${mode}-${++index}`;
    })(),
    trace: { emit: (event) => trace.push(event) },
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
    modelTurns: trace.filter((event) => event.type === 'model_usage').length,
    durationMs: Date.now() - startedAt,
  };
}

function createModelProvider(fixture: RecommendationFixture, mode: ReplayMode): ModelProvider {
  if (mode === 'fixture') return new FixtureModelProvider(fixture.modelResponses);
  if (mode === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    return new AnthropicModelProvider({ apiKey, model: process.env.ANTHROPIC_MODEL });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAIModelProvider({ apiKey, model: process.env.OPENAI_MODEL });
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

function sendJson(res: { setHeader(name: string, value: string): void; end(body: string): void }, body: unknown) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req: NodeJS.ReadableStream): Promise<{ fixtureId?: string; mode?: unknown; artifact?: unknown; path?: unknown }> {
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
    const evaluation = assertReplayArtifactShape(artifact);
    const usage = summarizeTraceUsage(artifact.trace);
    summaries.push({
      path: relativeFromWorkspace(path),
      createdAt: typeof artifact.createdAt === 'string' ? artifact.createdAt : '',
      provider: artifact.provider,
      fixture: artifact.fixture,
      evalOk: evaluation.ok,
      issues: evaluation.issues,
      recommendationCount: Array.isArray(artifact.recommendations) ? artifact.recommendations.length : 0,
      durationMs: typeof artifact.durationMs === 'number' ? artifact.durationMs : 0,
      modelTurns: typeof artifact.modelTurns === 'number' ? artifact.modelTurns : 0,
      usage,
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
      usage: summarizeTraceUsage(replay.trace),
    });
  }

  return summaries.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
}

function assertBehavioralExpectations(
  recommendations: Recommendation[],
  expectations: BehavioralExpectations | undefined,
) {
  const issues: { path: string; message: string }[] = [];
  if (!expectations) return { name: 'recommendation-behavior', ok: true, issues };

  for (const feature of expectations.requiredFeatures ?? []) {
    if (!recommendations.some((recommendation) => recommendation.bloomreachFeature === feature)) {
      issues.push({
        path: 'expectations.requiredFeatures',
        message: `expected at least one recommendation with bloomreachFeature=${feature}`,
      });
    }
  }

  const haystack = recommendations.map(recommendationSearchText).join('\n').toLowerCase();
  for (const text of expectations.requiredText ?? []) {
    if (!haystack.includes(text.toLowerCase())) {
      issues.push({
        path: 'expectations.requiredText',
        message: `expected recommendation text to include "${text}"`,
      });
    }
  }

  return { name: 'recommendation-behavior', ok: issues.length === 0, issues };
}

function recommendationSearchText(recommendation: Recommendation): string {
  return [
    recommendation.title,
    recommendation.rationale,
    recommendation.bloomreachFeature,
    ...recommendation.steps,
    typeof recommendation.estimatedImpact === 'string'
      ? recommendation.estimatedImpact
      : [
          recommendation.estimatedImpact.range,
          recommendation.estimatedImpact.assumption,
        ].join(' '),
    recommendation.successMetric,
    ...(recommendation.prerequisites ?? []).map((prerequisite) => prerequisite.label),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

async function promoteReplayArtifact(artifactPath: string) {
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  const evaluation = assertReplayArtifactShape(artifact);
  if (!evaluation.ok) {
    throw new Error(`replay artifact is not promotable: ${evaluation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }

  const sourceFixturePath = resolve(workspaceRoot(), artifact.fixture.path);
  const sourceFixture = JSON.parse(await readFile(sourceFixturePath, 'utf8'));
  const providerId = artifact.provider.id;
  const promotedId = `${artifact.fixture.id}-${providerId}-promoted`;
  const promoted = {
    ...sourceFixture,
    id: promotedId,
    description: [
      `Promoted deterministic fixture from ${providerId} replay artifact.`,
      `Source fixture: ${artifact.fixture.id}.`,
      `Replay created at: ${artifact.createdAt}.`,
    ].join(' '),
    modelResponses: [
      {
        content: [
          {
            type: 'text',
            text: `\`\`\`json\n${JSON.stringify(toAscii(stripRecommendationIds(artifact.recommendations)), null, 2)}\n\`\`\``,
          },
        ],
        usage: {
          inputTokens: summarizeTraceUsage(artifact.trace).inputTokens,
          outputTokens: summarizeTraceUsage(artifact.trace).outputTokens,
          estimated: true,
        },
        model: `promoted-${providerId}-replay`,
      },
    ],
    promotion: {
      sourceArtifact: relativeFromWorkspace(artifactPath),
      sourceProvider: artifact.provider,
      promotedAt: new Date().toISOString(),
      note: 'This fixture captures the final replay answer deterministically; it does not reconstruct the live provider tool loop.',
    },
  };

  const artifactDate = new Date(artifact.createdAt);
  const outDir = resolve(workspaceRoot(), 'packages/agents/recommendation/fixtures/promoted');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${slugify(promotedId)}-${formatDateForFilename(artifactDate)}.json`);
  await writeFile(outPath, `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');

  return {
    path: relativeFromWorkspace(outPath),
    id: promoted.id,
    sourceArtifact: promoted.promotion.sourceArtifact,
    recommendationCount: Array.isArray(artifact.recommendations) ? artifact.recommendations.length : 0,
  };
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

function summarizeTraceUsage(trace: unknown) {
  const events = Array.isArray(trace) ? trace : [];
  return events.reduce(
    (summary, event) => {
      if (!isRecord(event) || event.type !== 'model_usage') return summary;
      const inputTokens = typeof event.inputTokens === 'number' ? event.inputTokens : 0;
      const outputTokens = typeof event.outputTokens === 'number' ? event.outputTokens : 0;
      return {
        inputTokens: summary.inputTokens + inputTokens,
        outputTokens: summary.outputTokens + outputTokens,
        totalTokens: summary.totalTokens + inputTokens + outputTokens,
      };
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
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
  if (!Array.isArray(value.recommendations)) throw new Error('artifact recommendations must be an array');
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
