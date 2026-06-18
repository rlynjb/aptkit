import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const args = parseArgs({
  options: {
    runner: { type: 'string' },
    count: { type: 'string' },
    empty: { type: 'string' },
  },
});

const runnerPath = args.values.runner ?? 'dist/scripts/replay-fixture.js';
const countField = args.values.count ?? 'itemCount';
const emptyMessage = args.values.empty ?? 'no promoted fixtures found';
const promotedDir = join(process.cwd(), 'fixtures/promoted');
const fixturePaths = await listJsonFiles(promotedDir);

if (fixturePaths.length === 0) {
  console.log(JSON.stringify({ ok: true, checked: 0, message: emptyMessage }, null, 2));
  process.exit(0);
}

const { runFixtureReplay } = await import(pathToFileURL(resolve(process.cwd(), runnerPath)).href);
const results = [];

for (const fixturePath of fixturePaths) {
  const result = await runFixtureReplay(fixturePath);
  results.push({
    fixture: result.fixture,
    path: fixturePath,
    ok: result.eval.ok && result.behavior.ok,
    issues: [
      ...result.eval.issues.map((issue) => ({ ...issue, source: result.eval.name })),
      ...result.behavior.issues.map((issue) => ({ ...issue, source: result.behavior.name })),
    ],
    [countField]: outputCount(result, countField),
  });
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checked: results.length, failed: failed.length, results }, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}

function outputCount(result, field) {
  if (field === 'recommendationCount') return Array.isArray(result.recommendations) ? result.recommendations.length : 0;
  if (field === 'anomalyCount') return Array.isArray(result.anomalies) ? result.anomalies.length : 0;
  if (field === 'diagnosisPresent') return result.diagnosis && typeof result.diagnosis === 'object';
  return 0;
}

async function listJsonFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
