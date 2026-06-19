import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ensureGeneratedContent,
  planContentVariant,
  type ContentAngle,
  type ExistingContentVariant,
} from '../src/index.js';
import type { CapabilityEvent } from '@aptkit/runtime';

const angles: ContentAngle[] = [
  { id: 'visual', label: 'visual' },
  { id: 'importance', label: 'why it matters' },
  { id: 'tradeoffs', label: 'trade-offs' },
  { id: 'use_cases', label: 'use cases' },
];

const markdown = [
  'opening',
  '',
  '## First',
  'alpha',
  '',
  '## Second',
  'beta',
].join('\n');

describe('content generation workflow', () => {
  it('plans section and angle rotation deterministically', () => {
    const sections = [
      { content: 'opening' },
      { heading: 'First', content: 'alpha' },
      { heading: 'Second', content: 'beta' },
    ];

    assert.deepEqual(
      [0, 1, 2, 3].map((variantIndex) =>
        planContentVariant({ sourceHash: 'h1', variantIndex, sections, angles }),
      ).map((plan) => ({
        variantIndex: plan.variantIndex,
        sectionIndex: plan.sectionIndex,
        angleId: plan.angle.id,
      })),
      [
        { variantIndex: 0, sectionIndex: 0, angleId: 'visual' },
        { variantIndex: 1, sectionIndex: 1, angleId: 'importance' },
        { variantIndex: 2, sectionIndex: 2, angleId: 'tradeoffs' },
        { variantIndex: 3, sectionIndex: 0, angleId: 'use_cases' },
      ],
    );
  });

  it('returns fresh existing items without calling the generator when target is met', async () => {
    const existing: ExistingContentVariant[] = [
      { sourceHash: 'h1', variantIndex: 0 },
      { sourceHash: 'h1', variantIndex: 1 },
      { sourceHash: 'old', variantIndex: 0 },
    ];
    let calls = 0;

    const result = await ensureGeneratedContent({
      sourceMarkdown: markdown,
      sourceHash: 'h1',
      existing,
      targetCount: 2,
      angles,
      generator: async () => {
        calls += 1;
        return { title: 'unused' };
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.freshExisting.length, 2);
    assert.equal(result.staleExisting.length, 1);
    assert.deepEqual(result.generated, []);
    assert.deepEqual(result.items, result.freshExisting);
  });

  it('generates missing variants and reports stale items for host invalidation', async () => {
    const trace: CapabilityEvent[] = [];
    const existing: ExistingContentVariant[] = [
      { sourceHash: 'old', variantIndex: 0 },
    ];

    const result = await ensureGeneratedContent({
      capabilityId: 'content.test',
      sourceMarkdown: markdown,
      sourceHash: 'h2',
      existing,
      targetCount: 2,
      angles,
      trace: { emit: (event) => trace.push(event) },
      generator: async (plan) => ({
        title: `${plan.angle.id}:${plan.section.heading ?? 'opening'}`,
      }),
    });

    assert.deepEqual(result.staleExisting, existing);
    assert.equal(result.generated.length, 2);
    assert.deepEqual(result.generated.map((item) => item.variantIndex), [0, 1]);
    assert.deepEqual(result.generated.map((item) => item.item.title), [
      'visual:opening',
      'importance:First',
    ]);
    assert.equal(trace.filter((event) => event.type === 'step').length, 2);
  });

  it('skips failed variants and keeps filling within the bounded skip window', async () => {
    const attempted: number[] = [];

    const result = await ensureGeneratedContent({
      sourceMarkdown: markdown,
      sourceHash: 'h1',
      existing: [],
      targetCount: 2,
      maxSkips: 3,
      angles,
      generator: async (plan) => {
        attempted.push(plan.variantIndex);
        if (plan.variantIndex === 0) return null;
        return { variant: plan.variantIndex };
      },
    });

    assert.deepEqual(attempted, [0, 1, 2]);
    assert.deepEqual(result.skipped.map((plan) => plan.variantIndex), [0]);
    assert.deepEqual(result.generated.map((item) => item.variantIndex), [1, 2]);
  });

  it('stops after the bounded skip window when generation keeps failing', async () => {
    const result = await ensureGeneratedContent({
      sourceMarkdown: markdown,
      sourceHash: 'h1',
      existing: [],
      targetCount: 2,
      maxSkips: 1,
      angles,
      generator: async () => null,
    });

    assert.deepEqual(result.generated, []);
    assert.deepEqual(result.attempted.map((plan) => plan.variantIndex), [0, 1, 2]);
    assert.deepEqual(result.skipped.map((plan) => plan.variantIndex), [0, 1, 2]);
  });
});
