export type { WorkspaceDescriptor } from '@aptkit/context';

export type Intent = 'monitoring' | 'diagnostic' | 'recommendation';

export type QueryAnswer = {
  answer: string;
};
