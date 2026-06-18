export type StructuralIssue = {
  path: string;
  message: string;
};

export type StructuralDiffResult = {
  ok: boolean;
  issues: StructuralIssue[];
};

export function assertRequiredPaths(value: unknown, paths: readonly string[]): StructuralDiffResult {
  const issues: StructuralIssue[] = [];

  for (const path of paths) {
    const found = getPath(value, path);
    if (!found.exists) {
      issues.push({ path, message: 'required path is missing' });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function getPath(value: unknown, path: string): { exists: boolean; value: unknown } {
  const parts = path.split('.').filter(Boolean);
  let current = value;

  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { exists: false, value: undefined };
      }
      current = current[index];
      continue;
    }

    if (!current || typeof current !== 'object' || !(part in current)) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }

  return { exists: true, value: current };
}
