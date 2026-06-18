import type { AnomalyCategory, CategoryCoverage, CategoryCoverageItem, WorkspaceDescriptor } from './types.js';

const windowText = 'in last 90 days';

export const ECOMMERCE_ANOMALY_CATEGORIES: AnomalyCategory[] = [
  {
    id: 'conversion_drop',
    label: 'conversion rate drop',
    requires: ['view_item', 'checkout', 'purchase'],
    whyItMatters: 'conversion is the funnel hinge; a drop here loses completed-intent customers even at flat traffic.',
    queryRecipe: `select count event view_item, count event checkout, count event purchase ${windowText}`,
    thresholds: { critical: 20, warning: 10 },
  },
  {
    id: 'cart_abandonment',
    label: 'cart abandonment',
    requires: ['cart_update', 'checkout', 'purchase'],
    whyItMatters: 'rising abandonment means shoppers fill carts but stall before paying.',
    queryRecipe: `select count event cart_update, count event checkout, count event purchase ${windowText}`,
    thresholds: { critical: 20, warning: 10 },
  },
  {
    id: 'product_demand',
    label: 'product demand spike',
    requires: ['purchase'],
    whyItMatters: 'a sudden SKU or category velocity spike is an opportunity to protect stock and ride demand.',
    queryRecipe: `select count event purchase by event purchase.product_id grouping top 10 ${windowText}`,
    thresholds: { critical: 100, warning: 50 },
  },
  {
    id: 'revenue_drop',
    label: 'revenue drop',
    requires: ['purchase'],
    whyItMatters: 'revenue moves flow directly to income; isolate whether the move is demand or conversion.',
    queryRecipe: `select sum event purchase.total_price, count event purchase ${windowText}`,
    thresholds: { critical: 20, warning: 10 },
  },
  {
    id: 'customer_churn',
    label: 'customer churn',
    requires: ['purchase', 'session_start'],
    whyItMatters: 'falling repeat purchase reflects customers not coming back.',
    queryRecipe: `select count event purchase, count event session_start ${windowText}`,
    thresholds: { critical: 15, warning: 8 },
  },
  {
    id: 'inventory',
    label: 'inventory problems',
    requires: ['purchase'],
    enriches: ['catalog:inventory_level'],
    whyItMatters: 'sell-through outrunning replenishment creates stockouts and lost sales.',
    queryRecipe: `select count event purchase by event purchase.product_id grouping top 10 ${windowText}`,
    thresholds: { critical: 30, warning: 15 },
  },
  {
    id: 'campaign_perf',
    label: 'campaign performance',
    requires: ['session_start'],
    enriches: ['session_start.utm_source'],
    whyItMatters: 'campaign traffic swings move the top of the funnel.',
    queryRecipe: `select count event session_start ${windowText}`,
    thresholds: { critical: 25, warning: 12 },
  },
  {
    id: 'search_failure',
    label: 'search failure',
    requires: ['search'],
    whyItMatters: 'zero-result searches are demand the catalog or relevance is failing to meet.',
    queryRecipe: `select count event search ${windowText}`,
    thresholds: { critical: 20, warning: 10 },
  },
  {
    id: 'return_spike',
    label: 'product return spike',
    requires: ['return'],
    whyItMatters: 'return spikes point at quality, sizing, or expectation gaps.',
    queryRecipe: `select count event return ${windowText}`,
    thresholds: { critical: 25, warning: 12 },
  },
  {
    id: 'fraud',
    label: 'fraud detection',
    requires: ['payment_failure'],
    whyItMatters: 'clusters of failed payments or anomalous orders can signal card testing or fraud.',
    queryRecipe: `select count event payment_failure ${windowText}`,
    thresholds: { critical: 20, warning: 10 },
  },
];

export function schemaCapabilities(workspace: Pick<WorkspaceDescriptor, 'events' | 'catalogs'>): Set<string> {
  const capabilities = new Set<string>();
  for (const event of workspace.events ?? []) {
    capabilities.add(event.name);
    for (const property of event.properties ?? []) {
      capabilities.add(`${event.name}.${property}`);
    }
  }
  for (const catalog of workspace.catalogs ?? []) {
    capabilities.add(`catalog:${catalog.name}`);
  }
  return capabilities;
}

export function categoryCoverage(category: AnomalyCategory, capabilities: Set<string>): CategoryCoverage {
  if (!category.requires.every((dependency) => capabilities.has(dependency))) return 'unavailable';
  if (category.enriches?.length && !category.enriches.every((dependency) => capabilities.has(dependency))) return 'limited';
  return 'full';
}

export function missingCapabilities(category: AnomalyCategory, capabilities: Set<string>): string[] {
  return [...category.requires, ...(category.enriches ?? [])].filter((dependency) => !capabilities.has(dependency));
}

export function coverageReport(
  categories: readonly AnomalyCategory[],
  capabilities: Set<string>,
): CategoryCoverageItem[] {
  return categories.map((category) => {
    const coverage = categoryCoverage(category, capabilities);
    const missing = missingCapabilities(category, capabilities);
    return {
      category: category.id,
      label: category.label,
      coverage,
      ...(coverage !== 'full' && missing.length ? { missing } : {}),
    };
  });
}

export function runnableCategories(
  categories: readonly AnomalyCategory[],
  capabilities: Set<string>,
): AnomalyCategory[] {
  return categories.filter((category) => categoryCoverage(category, capabilities) !== 'unavailable');
}
