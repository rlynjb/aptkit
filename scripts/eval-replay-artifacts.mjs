import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateReplayArtifactFiles, listReplayArtifacts } from '@aptkit/evals/replay-runner';

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
const report = await evaluateReplayArtifactFiles(paths, { cwd: repoRoot });

console.log(JSON.stringify(report, null, 2));

if (!report.ok) {
  process.exitCode = 1;
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
