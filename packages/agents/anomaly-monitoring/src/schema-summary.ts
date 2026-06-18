import type { WorkspaceDescriptor } from './types.js';

export function schemaSummary(workspace: WorkspaceDescriptor): string {
  const oldestDate = workspace.oldestTimestamp
    ? new Date(workspace.oldestTimestamp).toISOString().slice(0, 10)
    : 'unknown';
  const horizon = workspace.dataHorizon
    ? `Data horizon: ${workspace.dataHorizon.from} to ${workspace.dataHorizon.to} (${workspace.dataHorizon.durationDays} days; to exclusive).`
    : undefined;
  const events = workspace.events
    .slice(0, 20)
    .map((event) => `  - ${event.name} (${event.eventCount}): ${event.properties.slice(0, 10).join(', ') || '(no properties)'}`)
    .join('\n');
  const customerProperties = workspace.customerProperties.slice(0, 30).join(', ') || 'none';
  return [
    `Project: ${workspace.projectName} (${workspace.projectId})`,
    `Total customers: ${workspace.totalCustomers.toLocaleString()}`,
    `Total events: ${workspace.totalEvents.toLocaleString()}`,
    `Oldest data: ${oldestDate}`,
    ...(horizon ? [horizon] : []),
    `Catalogs: ${workspace.catalogs.map((catalog) => catalog.name).join(', ') || 'none'}`,
    '',
    'Top events:',
    events,
    '',
    `Customer properties: ${customerProperties}`,
  ].join('\n');
}
