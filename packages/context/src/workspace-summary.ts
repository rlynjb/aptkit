import type { WorkspaceDescriptor } from './workspace-descriptor.js';

export type WorkspaceSummaryOptions = {
  maxEvents?: number;
  maxEventProperties?: number;
  maxCustomerProperties?: number;
  horizonStyle?: 'arrow-with-query-rule' | 'plain';
  eventHeading?: string;
};

export function schemaSummary(
  workspace: WorkspaceDescriptor,
  options: WorkspaceSummaryOptions = {},
): string {
  const {
    maxEvents = 20,
    maxEventProperties = 10,
    maxCustomerProperties = 30,
    horizonStyle = 'arrow-with-query-rule',
    eventHeading = 'Top events (name, eventCount: properties):',
  } = options;
  const oldestDate = workspace.oldestTimestamp
    ? new Date(workspace.oldestTimestamp).toISOString().slice(0, 10)
    : 'unknown';

  const eventsText = workspace.events
    .slice(0, maxEvents)
    .map((event) => {
      const props = event.properties.slice(0, maxEventProperties).join(', ');
      return `  - ${event.name} (${event.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');

  const customerPropsText = workspace.customerProperties
    .slice(0, maxCustomerProperties)
    .join(', ') || 'none';
  const horizonLine = formatDataHorizon(workspace, horizonStyle);

  return [
    `Project: ${workspace.projectName} (${workspace.projectId})`,
    `Total customers: ${workspace.totalCustomers.toLocaleString()}`,
    `Total events: ${workspace.totalEvents.toLocaleString()}`,
    `Oldest data: ${oldestDate}`,
    ...(horizonLine ? [horizonLine] : []),
    `Catalogs: ${workspace.catalogs.map((catalog) => catalog.name).join(', ') || 'none'}`,
    '',
    eventHeading,
    eventsText,
    '',
    `Customer properties: ${customerPropsText}`,
  ].join('\n');
}

function formatDataHorizon(
  workspace: WorkspaceDescriptor,
  horizonStyle: WorkspaceSummaryOptions['horizonStyle'],
): string | null {
  if (!workspace.dataHorizon) return null;
  if (horizonStyle === 'plain') {
    return `Data horizon: ${workspace.dataHorizon.from} to ${workspace.dataHorizon.to} (${workspace.dataHorizon.durationDays} days; to exclusive).`;
  }
  return `Data horizon: ${workspace.dataHorizon.from} -> ${workspace.dataHorizon.to} (${workspace.dataHorizon.durationDays} days; to exclusive). ALL queries MUST land inside this window.`;
}
