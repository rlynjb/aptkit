export type WorkspaceEventDescriptor = {
  name: string;
  properties: string[];
  eventCount: number;
};

export type WorkspaceCatalogDescriptor = {
  id?: string;
  name: string;
};

export type DataHorizon = {
  from: string;
  to: string;
  durationDays: number;
};

export type WorkspaceDescriptor = {
  projectId: string;
  projectName: string;
  events: WorkspaceEventDescriptor[];
  customerProperties: string[];
  catalogs: WorkspaceCatalogDescriptor[];
  totalCustomers: number;
  totalEvents: number;
  oldestTimestamp: number | null;
  dataHorizon?: DataHorizon;
};
