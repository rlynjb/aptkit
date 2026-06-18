import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateReplayArtifact,
  evaluateReplayArtifactFiles,
  listReplayArtifacts,
} from '../src/replay-runner.js';

const trace = [
  {
    type: 'model_usage',
    capabilityId: 'test-agent',
    provider: 'fixture',
    model: 'fixture-model',
    inputTokens: 1,
    outputTokens: 1,
    timestamp: '2026-06-18T00:00:00.000Z',
  },
];

describe('replay eval runner', () => {
  it('lists replay artifact JSON files in deterministic order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aptkit-evals-'));
    await writeFile(join(dir, 'b.json'), '{}\n', 'utf8');
    await writeFile(join(dir, 'a.json'), '{}\n', 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'skip\n', 'utf8');

    assert.deepEqual((await listReplayArtifacts(dir)).map((path) => path.split('/').pop()), ['a.json', 'b.json']);
  });

  it('evaluates mixed replay artifact types', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aptkit-evals-'));
    const artifacts = [
      ['recommendation.json', recommendationArtifact()],
      ['monitoring.json', monitoringArtifact()],
      ['diagnostic.json', diagnosticArtifact()],
      ['query.json', queryArtifact()],
    ] as const;

    const paths = [];
    for (const [name, artifact] of artifacts) {
      const path = join(dir, name);
      await writeFile(path, `${JSON.stringify(artifact)}\n`, 'utf8');
      paths.push(path);
    }

    const report = await evaluateReplayArtifactFiles(paths, { cwd: dir });
    assert.equal(report.ok, true);
    assert.equal(report.checked, 4);
    assert.equal(report.failed, 0);
    assert.deepEqual(report.results.map((result) => result.path), artifacts.map(([name]) => name));
    assert.deepEqual(report.results.map((result) => result.capabilityId), [
      'recommendation-agent',
      'anomaly-monitoring-agent',
      'diagnostic-investigation-agent',
      'query-agent',
    ]);
  });

  it('reports invalid artifacts without throwing', () => {
    const summary = evaluateReplayArtifact({ schemaVersion: 2 }, 'bad.json');
    assert.equal(summary.ok, false);
    assert.equal(summary.path, 'bad.json');
    assert.equal(summary.capabilityId, 'recommendation-agent');
    assert.ok(summary.issues.some((issue) => issue.path === 'schemaVersion'));
  });

  it('returns an empty successful report for no paths', async () => {
    assert.deepEqual(await evaluateReplayArtifactFiles([]), {
      ok: true,
      checked: 0,
      failed: 0,
      results: [],
      message: 'no replay artifacts found',
    });
  });
});

function baseArtifact() {
  return {
    schemaVersion: 1,
    createdAt: '2026-06-18T00:00:00.000Z',
    durationMs: 1,
    provider: { id: 'fixture', model: 'fixture-model' },
    fixture: { id: 'fixture-1', path: 'fixtures/fixture.json' },
    trace,
    eval: { name: 'shape', ok: true, issues: [] },
    modelTurns: 1,
  };
}

function recommendationArtifact() {
  return {
    ...baseArtifact(),
    recommendations: [
      {
        title: 'Send a recovery campaign',
        rationale: 'The selected cohort dropped materially.',
        bloomreachFeature: 'campaign',
        steps: ['Build segment', 'Send campaign'],
        estimatedImpact: '+$1k',
        confidence: 'medium',
      },
    ],
  };
}

function monitoringArtifact() {
  return {
    ...baseArtifact(),
    capabilityId: 'anomaly-monitoring-agent',
    anomalies: [
      {
        metric: 'revenue',
        scope: ['SP'],
        change: { value: -12, direction: 'down', baseline: 100 },
        severity: 'warning',
      },
    ],
  };
}

function diagnosticArtifact() {
  return {
    ...baseArtifact(),
    capabilityId: 'diagnostic-investigation-agent',
    diagnosis: {
      conclusion: 'Voucher traffic declined after campaign stop.',
      evidence: ['voucher revenue down'],
      hypothesesConsidered: [{ hypothesis: 'Campaign stopped', supported: true }],
    },
  };
}

function queryArtifact() {
  return {
    ...baseArtifact(),
    capabilityId: 'query-agent',
    answer: 'Revenue in SP decreased because voucher-driven repeat purchase activity dropped.',
  };
}
