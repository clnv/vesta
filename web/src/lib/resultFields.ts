export const DEFAULT_HIDDEN_RESULT_FIELDS = ["_stream", "_stream_id", "file", "stream", "timestamp"];

export function isHiddenResultField(field: string, patterns: string[]): boolean {
  return patterns.some((pattern) => (
    pattern.endsWith("*")
      ? field.startsWith(pattern.slice(0, -1))
      : field === pattern
  ));
}

function filterValue(value: unknown, patterns: string[]): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const filtered = value.map((child, index) => {
      const next = filterValue(child, patterns);
      if (next !== value[index]) changed = true;
      return next;
    });
    return changed ? filtered : value;
  }
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  let changed = false;
  const filtered: Record<string, unknown> = {};
  for (const [field, child] of Object.entries(record)) {
    if (isHiddenResultField(field, patterns)) {
      changed = true;
      continue;
    }
    const next = filterValue(child, patterns);
    filtered[field] = next;
    if (next !== child) changed = true;
  }
  return changed ? filtered : value;
}

export function filterResultRows(
  rows: Record<string, unknown>[],
  patterns: string[],
): Record<string, unknown>[] {
  if (patterns.length === 0) return rows;
  let changed = false;
  const filtered = rows.map((row, index) => {
    const next = filterValue(row, patterns) as Record<string, unknown>;
    if (next !== rows[index]) changed = true;
    return next;
  });
  return changed ? filtered : rows;
}

export function parseHiddenResultFields(value: string): string[] {
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const part of value.split(/[\n,]/)) {
    const field = part.trim();
    if (!field || seen.has(field)) continue;
    seen.add(field);
    fields.push(field);
  }
  return fields;
}
