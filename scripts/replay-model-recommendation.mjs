import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { schemaSummary } from '@aptkit/context';
import { RecommendationAgent } from '@aptkit/agent-recommendation';
import { assertRecommendationShape } from '@aptkit/evals';
import { recommendationPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { OpenAIModelProvider } from '@aptkit/provider-openai';
import { InMemoryToolRegistry } from '@aptkit/tools';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const fixturePathsById = {
  'sp-revenue-drop': join(repoRoot, 'packages/agents/recommendation/fixtures/sp-revenue-drop.json'),
  'electronics-spike': join(repoRoot, 'packages/agents/recommendation/fixtures/electronics-spike.json'),
  'voucher-dropoff': join(repoRoot, 'packages/agents/recommendation/fixtures/voucher-dropoff.json'),
};

const args = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: 'string', short: 'p' },
    fixture: { type: 'string', short: 'f' },
    model: { type: 'string', short: 'm' },
    'out-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.values.help) {
  printHelp();
  process.exit(0);
}

await loadDotEnv(join(repoRoot, '.env'));

const providerId = parseProvider(args.values.provider ?? 'openai');
const fixtureSelector = args.values.fixture ?? args.positionals[0] ?? 'sp-revenue-drop';
const fixturePath = resolveFixturePath(fixtureSelector);
const outDir = resolve(repoRoot, args.values['out-dir'] ?? 'artifacts/replays');
const provider = createProvider(providerId, args.values.model);

const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const handlers = {};
for (const tool of fixture.tools) {
  handlers[tool.name] = () => tool.result;
}

const trace = [];
const agent = new RecommendationAgent({
  model: provider.modelProvider,
  tools: new InMemoryToolRegistry(fixture.tools, handlers),
  workspace: fixture.workspace,
  idGenerator: (() => {
    let index = 0;
    return () => `${fixture.id}-${provider.id}-${++index}`;
  })(),
  trace: { emit: (event) => trace.push(event) },
});

const startedAt = new Date();
const recommendations = await agent.propose(fixture.anomaly, fixture.diagnosis);
const completedAt = new Date();
const evalResult = assertRecommendationShape(recommendations);
const artifact = {
  schemaVersion: 1,
  createdAt: completedAt.toISOString(),
  durationMs: completedAt.getTime() - startedAt.getTime(),
  provider: {
    id: provider.id,
    model: provider.modelName,
  },
  fixture: {
    id: fixture.id,
    description: fixture.description,
    path: relativeFromRoot(fixturePath),
  },
  promptPackage: promptPackageProvenance(
    recommendationPromptPackage,
    renderPromptTemplate(recommendationPromptPackage.system, {
      schema: schemaSummary(fixture.workspace),
      project_id: fixture.workspace.projectId,
      diagnosis: JSON.stringify(fixture.diagnosis),
    }),
  ),
  recommendations,
  trace,
  eval: evalResult,
  modelTurns: trace.filter((event) => event.type === 'model_usage').length,
};

await mkdir(outDir, { recursive: true });
const artifactPath = join(outDir, `${formatTimestamp(completedAt)}-${slugify(fixture.id)}-${provider.id}.json`);
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  saved: relativeFromRoot(artifactPath),
  fixture: artifact.fixture.id,
  provider: artifact.provider,
  eval: artifact.eval,
  recommendationCount: recommendations.length,
  modelTurns: artifact.modelTurns,
}, null, 2));

if (!evalResult.ok) {
  process.exitCode = 1;
}

function parseProvider(value) {
  const provider = String(value).toLowerCase();
  if (provider === 'openai') return provider;
  throw new Error(`unsupported provider: ${value}. Currently supported: openai`);
}

function createProvider(provider, modelOverride) {
  if (provider !== 'openai') {
    throw new Error(`unsupported provider: ${provider}. Currently supported: openai`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured. Add it to .env or export it before running a model replay.');
  }

  const modelName = modelOverride ?? process.env.OPENAI_MODEL ?? 'gpt-4.1';
  return {
    id: 'openai',
    modelName,
    modelProvider: new OpenAIModelProvider({ apiKey, model: modelName }),
  };
}

function resolveFixturePath(selector) {
  if (fixturePathsById[selector]) return fixturePathsById[selector];
  return resolve(process.cwd(), selector);
}

function promptPackageProvenance(promptPackage, renderedPrompt) {
  return {
    id: promptPackage.id,
    version: promptPackage.version,
    capabilityId: promptPackage.capabilityId,
    templateHash: stableTextHash(promptPackage.system),
    templateChars: promptPackage.system.length,
    renderedHash: stableTextHash(renderedPrompt),
    renderedChars: renderedPrompt.length,
  };
}

function stableTextHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function loadDotEnv(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(rawValue.trim());
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fixture';
}

function relativeFromRoot(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function printHelp() {
  console.log(`Run the recommendation agent with a model provider and save a replay artifact.

Usage:
  npm run replay:model
  npm run replay:model -- --provider openai --fixture voucher-dropoff
  npm run replay:openai -- electronics-spike

Options:
  -p, --provider <name>   Model provider. Currently supported: openai. Defaults to openai.
  -f, --fixture <id|path> Fixture id or JSON path. Defaults to sp-revenue-drop.
  -m, --model <name>     Provider model. Defaults to provider env var or gpt-4.1.
      --out-dir <path>   Output directory. Defaults to artifacts/replays.
  -h, --help             Show this help.
`);
}
