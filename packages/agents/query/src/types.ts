export type Intent = 'monitoring' | 'diagnostic' | 'recommendation';

export type WorkspaceDescriptor = {
  projectId: string;
  projectName: string;
  events: { name: string; properties: string[]; eventCount: number }[];
  customerProperties: string[];
  catalogs: { id: string; name: string }[];
  totalCustomers: number;
  totalEvents: number;
  oldestTimestamp: number | null;
  dataHorizon?: { from: string; to: string; durationDays: number };
};

export type QueryAnswer = {
  answer: string;
};
