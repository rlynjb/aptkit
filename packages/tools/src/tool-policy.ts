import type { ModelTool } from '@aptkit/runtime';
import type { ToolDefinition } from './tool-registry.js';

/** Capability-scoped allowlist that keeps agents from seeing tools outside their role. */
export type ToolPolicy = {
  capabilityId: string;
  allowedTools: readonly string[];
};

/** Filters a registry catalog down to the provider-neutral tool schemas a model may call. */
export function filterToolsForPolicy(
  allTools: readonly ToolDefinition[],
  policy: ToolPolicy,
): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
}
