import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertReplayArtifactShape } from '@aptkit/evals';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const defaultOutDir = join(repoRoot, 'packages/agents/recommendation/fixtures/promoted');

const args = parseArgs({
  allowPositionals: true,
  options: {
    'artifact': { type: 'string', short: 'a' },
    'out-dir': { type: 'string' },
    'id': { type: 'string' },
    'description': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.values.help) {
  printHelp();
  process.exit(0);
}

const artifactSelector = args.values.artifact ?? args.positionals[0];
if (!artifactSelector) {
  throw new Error('missing replay artifact path. Pass a JSON file from artifacts/replays/.');
}

const artifactPath = resolve(process.cwd(), artifactSelector);
const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
const artifactEval = assertReplayArtifactShape(artifact);
if (!artifactEval.ok) {
  throw new Error(`replay artifact is not promotable:\n${artifactEval.issues.map(formatIssue).join('\n')}`);
}

const sourceFixturePath = resolve(repoRoot, artifact.fixture.path);
const sourceFixture = JSON.parse(await readFile(sourceFixturePath, 'utf8'));
const providerId = artifact.provider.id;
const artifactTimestamp = new Date(artifact.createdAt);
const promotedId = args.values.id ?? `${artifact.fixture.id}-${providerId}-promoted`;
const promoted = {
  ...sourceFixture,
  id: promotedId,
  description: args.values.description ?? [
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
        inputTokens: modelUsageTotals(artifact.trace).inputTokens,
        outputTokens: modelUsageTotals(artifact.trace).outputTokens,
        estimated: true,
      },
      model: `promoted-${providerId}-replay`,
    },
  ],
  promotion: {
    sourceArtifact: relativeFromRoot(artifactPath),
    sourceProvider: artifact.provider,
    promotedAt: new Date().toISOString(),
    note: 'This fixture captures the final replay answer deterministically; it does not reconstruct the live provider tool loop.',
  },
};

const outDir = resolve(repoRoot, args.values['out-dir'] ?? defaultOutDir);
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `${slugify(promotedId)}-${formatDateForFilename(artifactTimestamp)}.json`);
await writeFile(outPath, `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  promoted: relativeFromRoot(outPath),
  id: promoted.id,
  sourceArtifact: promoted.promotion.sourceArtifact,
  sourceProvider: promoted.promotion.sourceProvider,
  recommendationCount: artifact.recommendations.length,
}, null, 2));

function stripRecommendationIds(recommendations) {
  return recommendations.map((recommendation) => {
    const { id: _id, ...idlessRecommendation } = recommendation;
    return idlessRecommendation;
  });
}

function toAscii(value) {
  if (typeof value === 'string') return asciiString(value);
  if (Array.isArray(value)) return value.map(toAscii);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toAscii(child)]));
  }
  return value;
}

function asciiString(value) {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s*[\u2013\u2014]\s*/g, ' - ')
    .replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function modelUsageTotals(trace) {
  const usageEvents = Array.isArray(trace) ? trace.filter((event) => event?.type === 'model_usage') : [];
  return {
    inputTokens: usageEvents.reduce((total, event) => total + numeric(event.inputTokens), 0),
    outputTokens: usageEvents.reduce((total, event) => total + numeric(event.outputTokens), 0),
  };
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatIssue(issue) {
  return `- ${issue.path || '<root>'}: ${issue.message}`;
}

function formatDateForFilename(date) {
  if (Number.isNaN(date.getTime())) return 'unknown-date';
  return date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'promoted-fixture';
}

function relativeFromRoot(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function printHelp() {
  console.log(`Promote a saved replay artifact into a deterministic recommendation fixture.

Usage:
  npm run promote:replay -- artifacts/replays/example-openai.json
  npm run promote:replay -- --artifact artifacts/replays/example-openai.json --id reviewed-voucher-openai

Options:
  -a, --artifact <path>       Replay artifact JSON to promote.
      --out-dir <path>       Output directory. Defaults to packages/agents/recommendation/fixtures/promoted.
      --id <id>              Fixture id. Defaults to <source-fixture>-<provider>-promoted.
      --description <text>   Fixture description.
  -h, --help                 Show this help.
`);
}
