import type { ResultMode } from "../types";
import { columnsFromQuery } from "./logsql";
import { filterResultRows, isHiddenResultField } from "./resultFields";

const MAX_CLIPBOARD_BYTES = 5 << 20;

interface ShareBundleOptions {
  query: string;
  link: string;
  rows: Record<string, unknown>[];
  mode: ResultMode;
  chartImageDataURL?: string;
  hiddenResultFields?: string[];
  include?: {
    link: boolean;
    query: boolean;
    results: boolean;
  };
}

export function orderedColumns(rows: Record<string, unknown>[], preferred: string[] = []): string[] {
  const found = new Set<string>();
  for (const row of rows.slice(0, 500)) Object.keys(row).forEach((key) => found.add(key));
  const requested = preferred.filter((column, index) => column && preferred.indexOf(column) === index);
  const requestedSet = new Set(requested);
  const remaining = [...found].filter((column) => !requestedSet.has(column)).sort((a, b) => {
    const priority = (value: string) => value === "_time" ? 0 : value === "_msg" ? 1 : 2;
    return priority(a) - priority(b) || a.localeCompare(b);
  });
  return [...requested, ...remaining];
}

function tsvCell(value: unknown): string {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[,\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function formatRows(
  rows: Record<string, unknown>[],
  mode: ResultMode,
  format: "clipboard" | "csv" | "ndjson" = "clipboard",
  preferredColumns: string[] = [],
  hiddenResultFields: string[] = [],
): string {
  rows = filterResultRows(rows, hiddenResultFields);
  preferredColumns = preferredColumns.filter((column) => !isHiddenResultField(column, hiddenResultFields));
  if (format === "ndjson" || (format === "clipboard" && mode === "json")) {
    return rows.map((row) => JSON.stringify(row)).join("\n");
  }
  const columns = orderedColumns(rows, preferredColumns);
  const delimiter = format === "csv" ? "," : "\t";
  const cell = format === "csv" ? csvCell : tsvCell;
  return [columns.join(delimiter), ...rows.map((row) => columns.map((column) => cell(row[column])).join(delimiter))].join("\n");
}

function clipboardSelection(
  rows: Record<string, unknown>[],
  mode: ResultMode,
  preferredColumns: string[] = [],
  hiddenResultFields: string[] = [],
): { rows: Record<string, unknown>[]; text: string; truncated: boolean } {
  rows = filterResultRows(rows, hiddenResultFields);
  preferredColumns = preferredColumns.filter((column) => !isHiddenResultField(column, hiddenResultFields));
  const encoder = new TextEncoder();
  const text = formatRows(rows, mode, "clipboard", preferredColumns, hiddenResultFields);
  if (encoder.encode(text).byteLength <= MAX_CLIPBOARD_BYTES) {
    return { rows, text, truncated: false };
  }
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(formatRows(rows.slice(0, middle), mode, "clipboard", preferredColumns, hiddenResultFields)).byteLength <= MAX_CLIPBOARD_BYTES) low = middle;
    else high = middle - 1;
  }
  const selectedRows = rows.slice(0, low);
  return { rows: selectedRows, text: formatRows(selectedRows, mode, "clipboard", preferredColumns, hiddenResultFields), truncated: true };
}

export function clipboardRows(
  rows: Record<string, unknown>[],
  mode: ResultMode,
  preferredColumns: string[] = [],
  hiddenResultFields: string[] = [],
): { text: string; truncated: boolean } {
  const selection = clipboardSelection(rows, mode, preferredColumns, hiddenResultFields);
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
  { pattern: /^(?:fields|keep|delete|drop|rename|copy|filter|format|unpack_json|unpack_logfmt|unpack_syslog|stats|uniq|top|sort|limit|offset|first|last|sample|math|field_names|field_values|by|as|render|with)\b/, style: "color:#7c3aed;font-weight:600" },
  { pattern: /^(?:count|count_uniq|sum|max|min|avg|median|quantile|rate|row_max|row_min|anomalychart|areachart|barchart|card|columnchart|linechart|piechart|scatterchart|stackedareachart|table|timechart)\b/, style: "color:#9333ea" },
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

function resultsHTML(
  rows: Record<string, unknown>[],
  mode: ResultMode,
  preferredColumns: string[] = [],
  hiddenResultFields: string[] = [],
): string {
  rows = filterResultRows(rows, hiddenResultFields);
  preferredColumns = preferredColumns.filter((column) => !isHiddenResultField(column, hiddenResultFields));
  if (mode === "json") {
    const ndjson = rows.map((row) => JSON.stringify(row)).join("\n");
    return `<pre style="margin:0;padding:12px;border:1px solid #d1d5db;border-radius:6px;background:#f8fafc;color:#111827;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(ndjson)}</pre>`;
  }
  const columns = orderedColumns(rows, preferredColumns);
  const header = columns.map((column) => `<th style="padding:7px 9px;border:1px solid #cbd5e1;background:#f1f5f9;color:#334155;font:600 12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-align:left">${escapeHTML(column)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td style="padding:7px 9px;border:1px solid #d1d5db;color:#111827;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere">${htmlCell(row[column])}</td>`).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse;border-spacing:0"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

export function shareBundle({
  query, link, rows, mode, chartImageDataURL, hiddenResultFields = [], include,
}: ShareBundleOptions): { text: string; html: string; truncated: boolean } {
  const selected = include ?? { link: true, query: true, results: true };
  const standalone = Number(selected.link) + Number(selected.query) + Number(selected.results) === 1;
  const preferredColumns = columnsFromQuery(query);
  const results = selected.results
    ? clipboardSelection(rows, mode, preferredColumns, hiddenResultFields)
    : { rows: [], text: "", truncated: false };
  const chartImage = selected.results && mode === "chart" && chartImageDataURL;
  const resultLabel = chartImage
    ? `Chart (${rows.length.toLocaleString()} source rows):`
    : results.truncated ? `Results (excerpt of ${rows.length.toLocaleString()} rows):` : `Results (${rows.length.toLocaleString()} rows):`;
  const markdownResultLabel = chartImage
    ? `Chart source data: ${rows.length.toLocaleString()} rows`
    : results.truncated ? `Results: excerpt of ${rows.length.toLocaleString()} rows` : `Results: ${rows.length.toLocaleString()} rows`;
  const safeLink = selected.link ? escapeHTML(link) : "";
  const richResultLabel = escapeHTML(resultLabel.slice(0, -1));
  const text: string[] = [];
  const html: string[] = ['<div style="color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5">'];
  if (selected.link) {
    const label = selected.query ? "Query" : "Open shared query";
    text.push(standalone ? link : `[${label}](${markdownLinkTarget(link)})`);
    html.push(`<p style="margin:0 0 8px"><a href="${safeLink}" style="color:#2563eb;font-weight:700;text-decoration:underline">[${label}]</a></p>`);
  }
  if (selected.query) {
    if (text.length > 0) text.push("");
    text.push(standalone ? query : markdownCodeBlock(query, "logsql"));
    const queryHTML = `<pre style="margin:0 0 14px;padding:12px;border:1px solid #d1d5db;border-radius:6px;background:#f8fafc;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere"><code>${highlightLogSQL(query)}</code></pre>`;
    html.push(selected.link ? `<a href="${safeLink}" style="color:inherit;text-decoration:none">${queryHTML}</a>` : queryHTML);
  }
  if (selected.results) {
    if (text.length > 0) text.push("");
    if (standalone) text.push(results.text);
    else text.push(markdownResultLabel, markdownCodeBlock(results.text, mode === "json" ? "json" : "tsv"));
    html.push(
      `<p style="margin:0 0 6px;color:#334155;font-weight:700">${richResultLabel}</p>`,
      chartImage
        ? `<img src="${escapeHTML(chartImage)}" alt="Rendered query chart" style="display:block;max-width:960px;width:100%;height:auto;border:1px solid #d1d5db;border-radius:6px;background:#fff" />`
        : resultsHTML(results.rows, mode, preferredColumns, hiddenResultFields),
    );
  }
  html.push("</div>");
  return {
    text: text.join("\n"),
    html: html.join(""),
    truncated: results.truncated,
  };
}
