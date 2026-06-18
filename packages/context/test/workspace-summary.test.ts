import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { schemaSummary, type WorkspaceDescriptor } from '../src/index.js';

const workspace: WorkspaceDescriptor = {
  projectId: 'olist',
  projectName: 'Olist Demo',
  totalCustomers: 12345,
  totalEvents: 67890,
  oldestTimestamp: Date.parse('2026-01-02T12:00:00Z'),
  dataHorizon: { from: '2026-01-01', to: '2026-06-01', durationDays: 151 },
  catalogs: [{ name: 'products' }],
  customerProperties: ['state', 'first_order_at', 'preferred_payment'],
  events: [
    { name: 'purchase', eventCount: 1000, properties: ['order_id', 'price', 'state'] },
    { name: 'checkout', eventCount: 900, properties: [] },
  ],
};

describe('schemaSummary', () => {
  it('renders a deterministic bounded workspace summary', () => {
    assert.equal(
      schemaSummary(workspace),
      [
        'Project: Olist Demo (olist)',
        'Total customers: 12,345',
        'Total events: 67,890',
        'Oldest data: 2026-01-02',
        'Data horizon: 2026-01-01 -> 2026-06-01 (151 days; to exclusive). ALL queries MUST land inside this window.',
        'Catalogs: products',
        '',
        'Top events (name, eventCount: properties):',
        '  - purchase (1000): order_id, price, state',
        '  - checkout (900): (no properties)',
        '',
        'Customer properties: state, first_order_at, preferred_payment',
      ].join('\n'),
    );
  });

  it('supports the existing plain monitoring horizon style', () => {
    assert.match(
      schemaSummary(workspace, { horizonStyle: 'plain', eventHeading: 'Top events:' }),
      /Data horizon: 2026-01-01 to 2026-06-01/,
    );
  });
});
