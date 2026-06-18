export type PromptVariable = {
  name: string;
  description: string;
  required: boolean;
};

export type PromptExample = {
  name: string;
  input: Record<string, unknown>;
  expectedContains?: string[];
};

export type PromptPackage = {
  id: string;
  version: string;
  capabilityId: string;
  description: string;
  system: string;
  compactSystem?: string;
  variables: PromptVariable[];
  examples: PromptExample[];
};

export function renderPromptTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : value;
  });
}
