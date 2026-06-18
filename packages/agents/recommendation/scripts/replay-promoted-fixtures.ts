import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { runFixtureReplay } from './replay-fixture.js';

const promotedDir = join(process.cwd(), 'fixtures/promoted');
const fixturePaths = await listJsonFiles(promotedDir);

if (fixturePaths.length === 0) {
  console.log(JSON.stringify({ ok: true, checked: 0, message: 'no promoted fixtures found' }, null, 2));
  process.exit(0);
}

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
    recommendationCount: result.recommendations.length,
  });
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checked: results.length, failed: failed.length, results }, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}

async function listJsonFiles(dir: string): Promise<string[]> {
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
