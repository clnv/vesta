import type { ResultMode } from "../types";

const MAX_CLIPBOARD_BYTES = 5 << 20;

export function orderedColumns(rows: Record<string, unknown>[]): string[] {
  const found = new Set<string>();
  for (const row of rows.slice(0, 500)) Object.keys(row).forEach((key) => found.add(key));
  return [...found].sort((a, b) => {
    const priority = (value: string) => value === "_time" ? 0 : value === "_msg" ? 1 : 2;
    return priority(a) - priority(b) || a.localeCompare(b);
  });
}

function tsvCell(value: unknown): string {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[,\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function formatRows(rows: Record<string, unknown>[], mode: ResultMode, format: "clipboard" | "csv" | "ndjson" = "clipboard"): string {
  if (format === "ndjson" || (format === "clipboard" && mode !== "table")) {
    return rows.map((row) => JSON.stringify(row)).join("\n");
  }
  const columns = orderedColumns(rows);
  const delimiter = format === "csv" ? "," : "\t";
  const cell = format === "csv" ? csvCell : tsvCell;
  return [columns.join(delimiter), ...rows.map((row) => columns.map((column) => cell(row[column])).join(delimiter))].join("\n");
}

export function clipboardRows(rows: Record<string, unknown>[], mode: ResultMode): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(formatRows(rows, mode)).byteLength <= MAX_CLIPBOARD_BYTES) {
    return { text: formatRows(rows, mode), truncated: false };
  }
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(formatRows(rows.slice(0, middle), mode)).byteLength <= MAX_CLIPBOARD_BYTES) low = middle;
    else high = middle - 1;
  }
  return { text: formatRows(rows.slice(0, low), mode), truncated: true };
}

