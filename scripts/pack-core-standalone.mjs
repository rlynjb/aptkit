import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packDir = process.env.APTKIT_PACK_DIR ?? '/private/tmp/aptkit-packs';
const npmCache = process.env.APTKIT_NPM_CACHE ?? '/private/tmp/npm-cache';
const packageSpecs = [
  { workspace: '@aptkit/runtime', tarball: 'aptkit-runtime-0.0.0.tgz' },
  { workspace: '@aptkit/tools', tarball: 'aptkit-tools-0.0.0.tgz' },
  { workspace: '@aptkit/context', tarball: 'aptkit-context-0.0.0.tgz' },
  { workspace: '@aptkit/prompts', tarball: 'aptkit-prompts-0.0.0.tgz' },
  { workspace: '@aptkit/evals', tarball: 'aptkit-evals-0.0.0.tgz' },
  { workspace: '@aptkit/workflows', tarball: 'aptkit-workflows-0.0.0.tgz' },
  { workspace: '@aptkit/agent-anomaly-monitoring', tarball: 'aptkit-agent-anomaly-monitoring-0.0.0.tgz' },
  { workspace: '@aptkit/agent-diagnostic-investigation', tarball: 'aptkit-agent-diagnostic-investigation-0.0.0.tgz' },
  { workspace: '@aptkit/agent-query', tarball: 'aptkit-agent-query-0.0.0.tgz' },
  { workspace: '@aptkit/agent-recommendation', tarball: 'aptkit-agent-recommendation-0.0.0.tgz' },
];

await mkdir(packDir, { recursive: true });

run('npm', [
  '--cache',
  npmCache,
  'pack',
  ...packageSpecs.flatMap((spec) => ['-w', spec.workspace]),
  '--pack-destination',
  packDir,
]);

const stage = await mkdtemp(join(tmpdir(), 'aptkit-core-standalone-'));
const corePackageDir = join(root, 'packages/core');

await cp(join(corePackageDir, 'README.md'), join(stage, 'README.md'));
await cp(join(corePackageDir, 'dist/src'), join(stage, 'dist/src'), { recursive: true });

const packageJson = JSON.parse(await readFile(join(corePackageDir, 'package.json'), 'utf8'));
delete packageJson.devDependencies;
await writeFile(join(stage, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

for (const spec of packageSpecs) {
  const packageDir = join(stage, 'node_modules', ...spec.workspace.split('/'));
  await mkdir(packageDir, { recursive: true });
  run('tar', [
    '-xzf',
    join(packDir, spec.tarball),
    '-C',
    packageDir,
    '--strip-components=1',
  ]);
}

run('npm', ['--cache', npmCache, 'pack', '--pack-destination', packDir], { cwd: stage });

const packedPackageName = packageJson.name.replace(/^@/, '').replace('/', '-');
console.log(join(packDir, `${packedPackageName}-${packageJson.version}.tgz`));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}
