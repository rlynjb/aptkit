export type CapabilityDescriptorSource = {
  events?: readonly { name: string; properties?: readonly string[] }[];
  catalogs?: readonly { name: string }[];
};

export type CoverageLevel = 'full' | 'limited' | 'unavailable';

export type CoverageRequirement = {
  id: string;
  label: string;
  requires: readonly string[];
  enriches?: readonly string[];
};

export type CoverageReportItem = {
  category: string;
  label: string;
  coverage: CoverageLevel;
  missing?: string[];
};

/** Builds capability tokens such as event names, event properties, and catalogs from a workspace-like descriptor. */
export function schemaCapabilities(source: CapabilityDescriptorSource): Set<string> {
  const capabilities = new Set<string>();
  for (const event of source.events ?? []) {
    capabilities.add(event.name);
    for (const property of event.properties ?? []) {
      capabilities.add(`${event.name}.${property}`);
    }
  }
  for (const catalog of source.catalogs ?? []) {
    capabilities.add(`catalog:${catalog.name}`);
  }
  return capabilities;
}

/** Classifies whether a task can run completely, partially, or not at all from the available capabilities. */
export function requirementCoverage(
  requirement: CoverageRequirement,
  capabilities: ReadonlySet<string>,
): CoverageLevel {
  if (!requirement.requires.every((dependency) => capabilities.has(dependency))) return 'unavailable';
  if (requirement.enriches?.length && !requirement.enriches.every((dependency) => capabilities.has(dependency))) return 'limited';
  return 'full';
}

/** Lists required or enriching capabilities that are absent for a task. */
export function missingCapabilities(
  requirement: CoverageRequirement,
  capabilities: ReadonlySet<string>,
): string[] {
  return [...requirement.requires, ...(requirement.enriches ?? [])].filter((dependency) => !capabilities.has(dependency));
}

/** Produces an inspectable coverage report for Studio previews and pre-model gating. */
export function coverageReport(
  requirements: readonly CoverageRequirement[],
  capabilities: ReadonlySet<string>,
): CoverageReportItem[] {
  return requirements.map((requirement) => {
    const coverage = requirementCoverage(requirement, capabilities);
    const missing = missingCapabilities(requirement, capabilities);
    return {
      category: requirement.id,
      label: requirement.label,
      coverage,
      ...(coverage !== 'full' && missing.length ? { missing } : {}),
    };
  });
}

/** Filters out tasks that cannot run before the agent spends model tokens on them. */
export function runnableRequirements<T extends CoverageRequirement>(
  requirements: readonly T[],
  capabilities: ReadonlySet<string>,
): T[] {
  return requirements.filter((requirement) => requirementCoverage(requirement, capabilities) !== 'unavailable');
}
