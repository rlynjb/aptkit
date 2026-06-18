import type { WorkspaceDescriptor } from './types.js';

export function schemaSummary(schema: WorkspaceDescriptor): string {
  const oldestDate = schema.oldestTimestamp
    ? new Date(schema.oldestTimestamp).toISOString().slice(0, 10)
    : 'unknown';

  const eventsText = schema.events
    .slice(0, 20)
    .map((event) => {
      const props = event.properties.slice(0, 10).join(', ');
      return `  - ${event.name} (${event.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');

  const customerPropsText = schema.customerProperties.slice(0, 30).join(', ');
  const horizonLine = schema.dataHorizon
    ? `Data horizon: ${schema.dataHorizon.from} -> ${schema.dataHorizon.to} (${schema.dataHorizon.durationDays} days; to exclusive). ALL queries MUST land inside this window.`
    : null;

  return [
    `Project: ${schema.projectName} (${schema.projectId})`,
    `Total customers: ${schema.totalCustomers.toLocaleString()}`,
    `Total events: ${schema.totalEvents.toLocaleString()}`,
    `Oldest data: ${oldestDate}`,
    ...(horizonLine ? [horizonLine] : []),
    `Catalogs: ${schema.catalogs.map((catalog) => catalog.name).join(', ') || 'none'}`,
    '',
    'Top events (name, eventCount: properties):',
    eventsText,
    '',
    `Customer properties: ${customerPropsText}`,
  ].join('\n');
}
