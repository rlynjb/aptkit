import type { DiagnosticFixture, MonitoringFixture, QueryFixture, RecommendationFixture } from './types';
import monitoringFixture from '../../../packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json';
import diagnosticFixture from '../../../packages/agents/diagnostic-investigation/fixtures/sp-revenue-diagnostic.json';
import queryFixture from '../../../packages/agents/query/fixtures/revenue-by-state-query.json';
import electronicsSpikeFixture from '../../../packages/agents/recommendation/fixtures/electronics-spike.json';
import spRevenueDropFixture from '../../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
import voucherDropoffFixture from '../../../packages/agents/recommendation/fixtures/voucher-dropoff.json';

export const fixtures = [
  spRevenueDropFixture,
  electronicsSpikeFixture,
  voucherDropoffFixture,
] as RecommendationFixture[];

export const monitoringFixtures = [
  monitoringFixture,
] as MonitoringFixture[];

export const diagnosticFixtures = [
  diagnosticFixture,
] as DiagnosticFixture[];

export const queryFixtures = [
  queryFixture,
] as QueryFixture[];
