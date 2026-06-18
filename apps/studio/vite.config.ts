import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { RecommendationAgent, FixtureModelProvider } from '@aptkit/agent-recommendation';
import { assertRecommendationShape } from '@aptkit/evals';
import { AnthropicModelProvider } from '@aptkit/provider-anthropic';
import { OpenAIModelProvider } from '@aptkit/provider-openai';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import type { CapabilityEvent, ModelProvider, ModelResponse } from '@aptkit/runtime';
import type { Anomaly, Diagnosis, WorkspaceDescriptor } from '@aptkit/agent-recommendation';
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
    mode,
    recommendations,
    trace,
    eval: evalResult,
    modelTurns: trace.filter((event) => event.type === 'model_usage').length,
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
  const workspaceRoot = resolve(studioDir, '../..');
  const env = {
    ...loadEnv(mode, workspaceRoot, ''),
    ...loadEnv(mode, studioDir, ''),
    ...process.env,
  };

  setProcessEnv('OPENAI_API_KEY', env.OPENAI_API_KEY);
  setProcessEnv('OPENAI_MODEL', env.OPENAI_MODEL);
  setProcessEnv('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
  setProcessEnv('ANTHROPIC_MODEL', env.ANTHROPIC_MODEL);

  return env;
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

function readJsonBody(req: NodeJS.ReadableStream): Promise<{ fixtureId?: string; mode?: unknown }> {
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
