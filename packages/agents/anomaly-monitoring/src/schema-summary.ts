import { schemaSummary as baseSchemaSummary } from '@aptkit/context';
import type { WorkspaceDescriptor } from './types.js';

export function schemaSummary(workspace: WorkspaceDescriptor): string {
  return baseSchemaSummary(workspace, {
    horizonStyle: 'plain',
    eventHeading: 'Top events:',
  });
}
