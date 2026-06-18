export type StructuralIssue = {
  path: string;
  message: string;
};

export type StructuralDiffResult = {
  ok: boolean;
  issues: StructuralIssue[];
};

export type StructuralDiffRule =
  | { type: 'required'; path: string; message?: string }
  | { type: 'equals'; path: string; expected: unknown; message?: string }
  | { type: 'number'; path: string; expected: number; tolerance?: number; message?: string }
  | { type: 'arrayCount'; path: string; exact?: number; min?: number; max?: number; message?: string }
  | { type: 'containsText'; path: string; text: string; caseSensitive?: boolean; message?: string }
  | { type: 'arrayIncludes'; path: string; value: unknown; itemPath?: string; message?: string };

/** Evaluates reusable structural rules against arbitrary JSON-like values. */
export function evaluateStructuralDiff(value: unknown, rules: readonly StructuralDiffRule[]): StructuralDiffResult {
  const issues: StructuralIssue[] = [];

  for (const rule of rules) {
    switch (rule.type) {
      case 'required':
        assertRequiredRule(value, rule, issues);
        break;
      case 'equals':
        assertEqualsRule(value, rule, issues);
        break;
      case 'number':
        assertNumberRule(value, rule, issues);
        break;
      case 'arrayCount':
        assertArrayCountRule(value, rule, issues);
        break;
      case 'containsText':
        assertContainsTextRule(value, rule, issues);
        break;
      case 'arrayIncludes':
        assertArrayIncludesRule(value, rule, issues);
        break;
    }
  }

  return { ok: issues.length === 0, issues };
}

export function assertRequiredPaths(value: unknown, paths: readonly string[]): StructuralDiffResult {
  return evaluateStructuralDiff(value, paths.map((path) => ({ type: 'required', path })));
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

function assertRequiredRule(
  value: unknown,
  rule: Extract<StructuralDiffRule, { type: 'required' }>,
  issues: StructuralIssue[],
): void {
  const found = getPath(value, rule.path);
  if (!found.exists) {
    issues.push({ path: rule.path, message: rule.message ?? 'required path is missing' });
  }
}

function assertEqualsRule(
  value: unknown,
  rule: Extract<StructuralDiffRule, { type: 'equals' }>,
  issues: StructuralIssue[],
): void {
  const found = getPath(value, rule.path);
  if (!found.exists) {
    issues.push({ path: rule.path, message: rule.message ?? 'required path is missing' });
    return;
  }
  if (!deepEqual(found.value, rule.expected)) {
    issues.push({ path: rule.path, message: rule.message ?? `expected ${formatValue(rule.expected)}` });
  }
}

function assertNumberRule(
  value: unknown,
  rule: Extract<StructuralDiffRule, { type: 'number' }>,
  issues: StructuralIssue[],
): void {
  const found = getPath(value, rule.path);
  if (!found.exists || typeof found.value !== 'number') {
    issues.push({ path: rule.path, message: rule.message ?? 'expected a number' });
    return;
  }
  const tolerance = rule.tolerance ?? 0;
  if (Math.abs(found.value - rule.expected) > tolerance) {
    issues.push({
      path: rule.path,
      message: rule.message ?? `expected ${rule.expected}${tolerance ? ` +/- ${tolerance}` : ''}`,
    });
  }
}

function assertArrayCountRule(
  value: unknown,
  rule: Extract<StructuralDiffRule, { type: 'arrayCount' }>,
  issues: StructuralIssue[],
): void {
  const found = getPath(value, rule.path);
  if (!found.exists || !Array.isArray(found.value)) {
    issues.push({ path: rule.path, message: rule.message ?? 'expected an array' });
    return;
  }

  const count = found.value.length;
  if (rule.exact !== undefined && count !== rule.exact) {
    issues.push({ path: rule.path, message: rule.message ?? `expected exactly ${rule.exact} items` });
  }
  if (rule.min !== undefined && count < rule.min) {
    issues.push({ path: rule.path, message: rule.message ?? `expected at least ${rule.min} items` });
  }
  if (rule.max !== undefined && count > rule.max) {
    issues.push({ path: rule.path, message: rule.message ?? `expected at most ${rule.max} items` });
  }
}

function assertContainsTextRule(
  value: unknown,
  rule: Extract<StructuralDiffRule, { type: 'containsText' }>,
  issues: StructuralIssue[],
): void {
  const found = getPath(value, rule.path);
  if (!found.exists) {
    issues.push({ path: rule.path, message: rule.message ?? 'required path is missing' });
    return;
  }

  const haystack = collectText(found.value, rule.caseSensitive !== true);
  const needle = rule.caseSensitive ? rule.text : rule.text.toLowerCase();
  if (!haystack.includes(needle)) {
    issues.push({ path: rule.path, message: rule.message ?? `expected text containing "${rule.text}"` });
  }
}

function assertArrayIncludesRule(
  value: unknown,
  rule: Extract<StructuralDiffRule, { type: 'arrayIncludes' }>,
  issues: StructuralIssue[],
): void {
  const found = getPath(value, rule.path);
  if (!found.exists || !Array.isArray(found.value)) {
    issues.push({ path: rule.path, message: rule.message ?? 'expected an array' });
    return;
  }

  const included = found.value.some((item) => {
    const candidate = rule.itemPath ? getPath(item, rule.itemPath) : { exists: true, value: item };
    if (!candidate.exists) return false;
    if (Array.isArray(candidate.value)) return candidate.value.some((entry) => deepEqual(entry, rule.value));
    return deepEqual(candidate.value, rule.value);
  });
  if (!included) {
    const path = rule.itemPath ? `${rule.path}.${rule.itemPath}` : rule.path;
    issues.push({ path, message: rule.message ?? `expected array containing ${formatValue(rule.value)}` });
  }
}

function collectText(value: unknown, normalize: boolean): string {
  if (typeof value === 'string') return normalize ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map((item) => collectText(item, normalize)).join('\n');
  if (value && typeof value === 'object') {
    return Object.values(value).map((item) => collectText(item, normalize)).join('\n');
  }
  return '';
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}
