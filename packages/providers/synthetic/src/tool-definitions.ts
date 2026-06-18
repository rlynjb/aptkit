import type { ToolDefinition } from '@aptkit/tools';

export const syntheticEcommerceToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_project_overview',
    description: 'Return synthetic ecommerce workspace metadata and data horizon.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_metric_timeseries',
    description: 'Return synthetic ecommerce metric timeseries for an optional dimension and segment.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string' },
        dimension: { type: 'string' },
        segment: { type: 'string' },
        time_range: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
          },
        },
        granularity: { type: 'string' },
      },
      required: ['metric'],
    },
  },
  {
    name: 'get_anomaly_context',
    description: 'Return synthetic ecommerce anomaly context, related segments, and sample records.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string' },
        dimension: { type: 'string' },
        segment: { type: 'string' },
        anomaly_window: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
          },
        },
        baseline_window: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
          },
        },
      },
      required: ['metric', 'dimension', 'segment'],
    },
  },
];
