import { timestamp, type CapabilityTraceSink } from '@aptkit/runtime';
import { splitMarkdownSections, type MarkdownSection } from './markdown-sections.js';

export type ContentAngle = {
  id: string;
  label: string;
};

export type ExistingContentVariant = {
  sourceHash: string;
  variantIndex: number;
};

export type ContentVariantPlan = {
  sourceHash: string;
  variantIndex: number;
  sectionIndex: number;
  totalSections: number;
  section: MarkdownSection;
  angle: ContentAngle;
};

export type GeneratedContentVariant<T> = ContentVariantPlan & {
  item: T;
};

export type ContentGenerator<T> = (
  plan: ContentVariantPlan,
  options?: { signal?: AbortSignal; trace?: CapabilityTraceSink },
) => Promise<T | null>;

export type EnsureGeneratedContentOptions<TExisting extends ExistingContentVariant, TGenerated> = {
  capabilityId?: string;
  sourceMarkdown: string;
  sourceHash: string;
  existing: readonly TExisting[];
  targetCount?: number;
  angles: readonly ContentAngle[];
  maxSkips?: number;
  generator: ContentGenerator<TGenerated>;
  trace?: CapabilityTraceSink;
  signal?: AbortSignal;
};

export type EnsureGeneratedContentResult<TExisting extends ExistingContentVariant, TGenerated> = {
  freshExisting: TExisting[];
  staleExisting: TExisting[];
  generated: GeneratedContentVariant<TGenerated>[];
  items: Array<TExisting | GeneratedContentVariant<TGenerated>>;
  attempted: ContentVariantPlan[];
  skipped: ContentVariantPlan[];
};

const DEFAULT_TARGET_COUNT = 4;
const DEFAULT_MAX_SKIPS = 3;

/**
 * Ensures a source document has enough generated variants for the current hash.
 *
 * The host owns persistence. This helper returns fresh existing variants,
 * stale variants to invalidate, and newly generated variants to save.
 */
export async function ensureGeneratedContent<TExisting extends ExistingContentVariant, TGenerated>(
  options: EnsureGeneratedContentOptions<TExisting, TGenerated>,
): Promise<EnsureGeneratedContentResult<TExisting, TGenerated>> {
  options.signal?.throwIfAborted();
  if (options.angles.length === 0) throw new Error('ensureGeneratedContent requires at least one angle');

  const capabilityId = options.capabilityId ?? 'content-generation-workflow';
  const targetCount = Math.max(0, options.targetCount ?? DEFAULT_TARGET_COUNT);
  const maxSkips = Math.max(0, options.maxSkips ?? DEFAULT_MAX_SKIPS);
  const sections = splitMarkdownSections(options.sourceMarkdown);
  const freshExisting = options.existing
    .filter((item) => item.sourceHash === options.sourceHash)
    .sort((a, b) => a.variantIndex - b.variantIndex);
  const staleExisting = options.existing
    .filter((item) => item.sourceHash !== options.sourceHash)
    .sort((a, b) => a.variantIndex - b.variantIndex);

  if (targetCount === 0 || sections.length === 0 || freshExisting.length >= targetCount) {
    return {
      freshExisting,
      staleExisting,
      generated: [],
      items: freshExisting,
      attempted: [],
      skipped: [],
    };
  }

  const needed = targetCount - freshExisting.length;
  const baseIndex = (freshExisting.at(-1)?.variantIndex ?? -1) + 1;
  const lastIndex = baseIndex + needed + maxSkips;
  const generated: GeneratedContentVariant<TGenerated>[] = [];
  const attempted: ContentVariantPlan[] = [];
  const skipped: ContentVariantPlan[] = [];

  for (let variantIndex = baseIndex; generated.length < needed && variantIndex < lastIndex; variantIndex += 1) {
    options.signal?.throwIfAborted();
    const plan = planContentVariant({
      sourceHash: options.sourceHash,
      variantIndex,
      sections,
      angles: options.angles,
    });
    attempted.push(plan);
    options.trace?.emit({
      type: 'step',
      capabilityId,
      role: 'workflow',
      content: `generating ${plan.angle.label} for section ${plan.sectionIndex + 1} of ${plan.totalSections}`,
      timestamp: timestamp(),
    });

    const item = await options.generator(plan, { signal: options.signal, trace: options.trace });
    if (item === null) {
      skipped.push(plan);
      options.trace?.emit({
        type: 'warning',
        capabilityId,
        message: `content variant ${variantIndex} produced no usable output; trying next variant`,
        timestamp: timestamp(),
      });
      continue;
    }
    generated.push({ ...plan, item });
  }

  return {
    freshExisting,
    staleExisting,
    generated,
    items: [...freshExisting, ...generated],
    attempted,
    skipped,
  };
}

export function planContentVariant(options: {
  sourceHash: string;
  variantIndex: number;
  sections: readonly MarkdownSection[];
  angles: readonly ContentAngle[];
}): ContentVariantPlan {
  if (options.sections.length === 0) throw new Error('planContentVariant requires at least one section');
  if (options.angles.length === 0) throw new Error('planContentVariant requires at least one angle');

  const sectionIndex = options.variantIndex % options.sections.length;
  return {
    sourceHash: options.sourceHash,
    variantIndex: options.variantIndex,
    sectionIndex,
    totalSections: options.sections.length,
    section: options.sections[sectionIndex],
    angle: options.angles[options.variantIndex % options.angles.length],
  };
}
