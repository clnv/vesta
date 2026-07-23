import type { ResultMode } from "../types";

const MAX_CLIPBOARD_BYTES = 5 << 20;

interface ShareBundleOptions {
  query: string;
  link: string;
  rows: Record<string, unknown>[];
  mode: ResultMode;
}

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

function clipboardSelection(rows: Record<string, unknown>[], mode: ResultMode): { rows: Record<string, unknown>[]; text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const text = formatRows(rows, mode);
  if (encoder.encode(text).byteLength <= MAX_CLIPBOARD_BYTES) {
    return { rows, text, truncated: false };
  }
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(formatRows(rows.slice(0, middle), mode)).byteLength <= MAX_CLIPBOARD_BYTES) low = middle;
    else high = middle - 1;
  }
  const selectedRows = rows.slice(0, low);
  return { rows: selectedRows, text: formatRows(selectedRows, mode), truncated: true };
}

export function clipboardRows(rows: Record<string, unknown>[], mode: ResultMode): { text: string; truncated: boolean } {
  const selection = clipboardSelection(rows, mode);
  return { text: selection.text, truncated: selection.truncated };
}

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownLinkTarget(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function markdownCodeBlock(value: string, language: string): string {
  const longestBacktickRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((match) => match.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

const LOGSQL_HIGHLIGHTS: { pattern: RegExp; style: string }[] = [
  { pattern: /^#[^\n]*/, style: "color:#64748b;font-style:italic" },
  { pattern: /^"(?:[^"\\]|\\.)*"/, style: "color:#047857" },
  { pattern: /^'(?:[^'\\]|\\.)*'/, style: "color:#047857" },
  { pattern: /^-?\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|w|y)?\b/, style: "color:#b45309" },
  { pattern: /^(?:AND|OR|NOT|in|exact|contains_any|contains_all)\b/i, style: "color:#be185d" },
  { pattern: /^(?:fields|keep|delete|drop|rename|copy|filter|format|unpack_json|unpack_logfmt|unpack_syslog|stats|uniq|top|sort|limit|offset|first|last|sample|math|field_names|field_values|by|as)\b/, style: "color:#7c3aed;font-weight:600" },
  { pattern: /^(?:count|count_uniq|sum|max|min|avg|median|quantile|rate|row_max|row_min)\b/, style: "color:#9333ea" },
  { pattern: /^_[A-Za-z0-9_.]+/, style: "color:#7c3aed" },
  { pattern: /^[A-Za-z][A-Za-z0-9_.-]*(?=\s*:)/, style: "color:#0369a1" },
  { pattern: /^(?:\||[=!~<>]+|:)/, style: "color:#be185d" },
];

export function highlightLogSQL(query: string): string {
  let highlighted = "";
  let index = 0;
  while (index < query.length) {
    const remaining = query.slice(index);
    const token = LOGSQL_HIGHLIGHTS.map(({ pattern, style }) => ({ match: remaining.match(pattern), style }))
      .find(({ match }) => Boolean(match?.[0]));
    if (token?.match?.[0]) {
      highlighted += `<span style="${token.style}">${escapeHTML(token.match[0])}</span>`;
      index += token.match[0].length;
    } else {
      highlighted += escapeHTML(query[index]);
      index += 1;
    }
  }
  return highlighted;
}

function htmlCell(value: unknown): string {
  if (value == null) return "";
  return escapeHTML(typeof value === "string" ? value : JSON.stringify(value));
}

function resultsHTML(rows: Record<string, unknown>[], mode: ResultMode): string {
  if (mode === "json") {
    const ndjson = rows.map((row) => JSON.stringify(row)).join("\n");
    return `<pre style="margin:0;padding:12px;border:1px solid #d1d5db;border-radius:6px;background:#f8fafc;color:#111827;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(ndjson)}</pre>`;
  }
  const columns = orderedColumns(rows);
  const header = columns.map((column) => `<th style="padding:7px 9px;border:1px solid #cbd5e1;background:#f1f5f9;color:#334155;font:600 12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-align:left">${escapeHTML(column)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td style="padding:7px 9px;border:1px solid #d1d5db;color:#111827;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere">${htmlCell(row[column])}</td>`).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse;border-spacing:0"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

export function shareBundle({ query, link, rows, mode }: ShareBundleOptions): { text: string; html: string; truncated: boolean } {
  const results = clipboardSelection(rows, mode);
  const resultLabel = results.truncated ? `Results (excerpt of ${rows.length.toLocaleString()} rows):` : `Results (${rows.length.toLocaleString()} rows):`;
  const markdownResultLabel = results.truncated ? `Results: excerpt of ${rows.length.toLocaleString()} rows` : `Results: ${rows.length.toLocaleString()} rows`;
  const safeLink = escapeHTML(link);
  const richResultLabel = escapeHTML(resultLabel.slice(0, -1));
  return {
    text: [
      `[Query](${markdownLinkTarget(link)})`,
      "",
      markdownCodeBlock(query, "logsql"),
      "",
      markdownResultLabel,
      markdownCodeBlock(results.text, mode === "table" ? "tsv" : "json"),
    ].join("\n"),
    html: [
      '<div style="color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5">',
      `<p style="margin:0 0 8px"><a href="${safeLink}" style="color:#2563eb;font-weight:700;text-decoration:underline">[Query]</a></p>`,
      `<a href="${safeLink}" style="color:inherit;text-decoration:none"><pre style="margin:0 0 14px;padding:12px;border:1px solid #d1d5db;border-radius:6px;background:#f8fafc;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere"><code>${highlightLogSQL(query)}</code></pre></a>`,
      `<p style="margin:0 0 6px;color:#334155;font-weight:700">${richResultLabel}</p>`,
      resultsHTML(results.rows, mode),
      "</div>",
    ].join(""),
    truncated: results.truncated,
  };
}
