import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertCapabilityReplayArtifactShape } from '@aptkit/evals';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const args = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', short: 'd' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.values.help) {
  printHelp();
  process.exit(0);
}

const paths = args.positionals.length
  ? args.positionals.map((path) => resolve(process.cwd(), path))
  : await listReplayArtifacts(resolve(repoRoot, args.values.dir ?? 'artifacts/replays'));

if (paths.length === 0) {
  console.log(JSON.stringify({ ok: true, checked: 0, message: 'no replay artifacts found' }, null, 2));
  process.exit(0);
}

const results = [];
for (const path of paths) {
  const raw = await readFile(path, 'utf8');
  const artifact = JSON.parse(raw);
  const result = assertCapabilityReplayArtifactShape(artifact);
  results.push({
    path: relativeFromRoot(path),
    ok: result.ok,
    issues: result.issues,
    capabilityId: artifact?.capabilityId ?? 'recommendation-agent',
    provider: artifact?.provider,
    fixture: artifact?.fixture?.id,
    recommendationCount: Array.isArray(artifact?.recommendations) ? artifact.recommendations.length : null,
    anomalyCount: Array.isArray(artifact?.anomalies) ? artifact.anomalies.length : null,
  });
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  checked: results.length,
  failed: failed.length,
  results,
}, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}

async function listReplayArtifacts(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
    .map((entry) => join(dir, entry.name))
    .sort();
}

function relativeFromRoot(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function printHelp() {
  console.log(`Evaluate saved replay artifacts.

Usage:
  npm run eval:replays
  npm run eval:replays -- artifacts/replays/example.json
  npm run eval:replays -- --dir artifacts/replays

Options:
  -d, --dir <path>  Directory to scan for replay JSON files. Defaults to artifacts/replays.
  -h, --help        Show this help.
`);
}
