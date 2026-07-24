export const DEFAULT_QUERY = [
  "_time:1h",
  "| sort by (_time) desc",
  "| limit 200",
].join("\n");

interface QueryRange {
  from: number;
  to: number;
}

export function queryAtCursor(document: string, cursor: number): string {
  if (!document.trim()) return "";
  const position = Math.max(0, Math.min(cursor, document.length));
  const ranges = queryRanges(document);
  const range = ranges.find(({ from, to }) => position >= from && position <= to);
  return range ? document.slice(range.from, range.to).trim() : "";
}

function queryRanges(document: string): QueryRange[] {
  const ranges: QueryRange[] = [];
  let from = 0;
  for (const terminator of statementTerminators(document)) {
    ranges.push(...blankLineQueryRanges(document, from, terminator));
    from = terminator + 1;
  }
  ranges.push(...blankLineQueryRanges(document, from, document.length));
  return ranges;
}

function statementTerminators(document: string): number[] {
  const terminators: number[] = [];
  let quote = "";
  let comment = false;
  for (let index = 0; index < document.length; index += 1) {
    const char = document[index];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (char === "\\" && quote !== "`") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "#") comment = true;
    else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === ";") terminators.push(index);
  }
  return terminators;
}

function blankLineQueryRanges(document: string, from: number, to: number): QueryRange[] {
  const paragraphs: QueryRange[] = [];
  const separator = /\n[ \t\r]*\n+/g;
  const segment = document.slice(from, to);
  let paragraphFrom = from;
  for (const match of segment.matchAll(separator)) {
    const separatorFrom = from + match.index;
    addTrimmedRange(paragraphs, document, paragraphFrom, separatorFrom);
    paragraphFrom = separatorFrom + match[0].length;
  }
  addTrimmedRange(paragraphs, document, paragraphFrom, to);
  if (paragraphs.length < 2) return paragraphs;

  const ranges: QueryRange[] = [];
  for (const paragraph of paragraphs) {
    const current = ranges.at(-1);
    if (current && continuesQuery(document.slice(paragraph.from, paragraph.to), document.slice(current.from, current.to))) {
      current.to = paragraph.to;
    } else {
      ranges.push({ ...paragraph });
    }
  }
  return ranges;
}

function continuesQuery(next: string, previous: string): boolean {
  const firstCodeLine = next.split("\n").find((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  })?.trim() ?? "";
  if (!firstCodeLine) return true;
  if (/^(?:\||and\b|or\b|[)\]}])/i.test(firstCodeLine)) return true;
  if (/[|,]$/.test(previous.trimEnd())) return true;
  return unclosedGroupDepth(previous) > 0;
}

function unclosedGroupDepth(query: string): number {
  let depth = 0;
  let quote = "";
  let comment = false;
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (char === "\\" && quote !== "`") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "#") comment = true;
    else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function addTrimmedRange(ranges: QueryRange[], document: string, from: number, to: number): void {
  while (from < to && /\s/.test(document[from])) from += 1;
  while (to > from && /\s/.test(document[to - 1])) to -= 1;
  if (from < to) ranges.push({ from, to });
}

export const SUPPORTED_RENDER_VISUALIZATIONS = [
  "anomalychart",
  "areachart",
  "barchart",
  "card",
  "columnchart",
  "linechart",
  "piechart",
  "scatterchart",
  "stackedareachart",
  "table",
  "timechart",
] as const;

export type RenderVisualization = typeof SUPPORTED_RENDER_VISUALIZATIONS[number];

export interface RenderDirective {
  visualization: string;
  supported: boolean;
  properties: Record<string, string>;
  executableQuery: string;
}

export function renderDirectiveFromQuery(query: string): RenderDirective | null {
  const pipe = lastTopLevelPipe(query);
  if (pipe < 0) return null;
  const stage = stripComments(query.slice(pipe + 1)).trim();
  const match = stage.match(/^render\s+([a-z][a-z0-9_]*)(?:\s+with\s*\(([\s\S]*)\))?$/i);
  if (!match) return null;
  const visualization = match[1].toLowerCase();
  return {
    visualization,
    supported: (SUPPORTED_RENDER_VISUALIZATIONS as readonly string[]).includes(visualization),
    properties: parseRenderProperties(match[2] ?? ""),
    executableQuery: query.slice(0, pipe).trimEnd(),
  };
}

function parseRenderProperties(value: string): Record<string, string> {
  const properties: Record<string, string> = {};
  let start = 0;
  let quote = "";
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "," && /^\s*[A-Za-z][A-Za-z0-9_]*\s*=/.test(value.slice(index + 1))) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    if (equals < 1) continue;
    const name = entry.slice(0, equals).trim().toLowerCase();
    let propertyValue = entry.slice(equals + 1).trim();
    if (
      propertyValue.length >= 2
      && ((propertyValue.startsWith('"') && propertyValue.endsWith('"'))
        || (propertyValue.startsWith("'") && propertyValue.endsWith("'")))
    ) {
      propertyValue = propertyValue.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (name) properties[name] = propertyValue;
  }
  return properties;
}

export function hasTimeFilter(query: string): boolean {
  for (let index = 0; index < query.length; ) {
    const char = query[index];
    if (char === "#") {
      while (index < query.length && query[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < query.length) {
        if (query[index] === "\\") {
          index += 2;
          continue;
        }
        if (query[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index < query.length && /[A-Za-z0-9_.]/.test(query[index])) index += 1;
      if (query.slice(start, index) !== "_time") continue;
      while (index < query.length && /\s/.test(query[index])) index += 1;
      if (query[index] === ":") return true;
      continue;
    }
    index += 1;
  }
  return false;
}

export function looksUnbounded(query: string): boolean {
  const clean = stripCommentsAndStrings(query);
  return clean.includes("_time:>") || clean.includes("_time:day_range") || clean.includes("_time:week_range");
}

export function columnsFromQuery(query: string): string[] {
  let fields: string[] = [];
  for (const stage of pipelineStages(query).slice(1)) {
    const match = stage.match(/^\s*(?:fields|keep)(?:\s+([\s\S]*?))?\s*$/i);
    if (match) fields = parseFieldList(match[1] ?? "");
  }
  return fields;
}

function pipelineStages(query: string): string[] {
  const stages = [""];
  let quote = "";
  let comment = false;
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (comment) {
      if (char === "\n") {
        comment = false;
        stages[stages.length - 1] += char;
      }
      continue;
    }
    if (quote) {
      stages[stages.length - 1] += char;
      if (char === "\\") {
        if (index + 1 < query.length) stages[stages.length - 1] += query[++index];
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "#") {
      comment = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      stages[stages.length - 1] += char;
    } else if (char === "|") {
      stages.push("");
    } else {
      stages[stages.length - 1] += char;
    }
  }
  return stages;
}

function parseFieldList(value: string): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  let field = "";
  let quote = "";
  const addField = () => {
    let name = field.trim();
    field = "";
    if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    } else if (/\s/.test(name)) {
      return;
    }
    if (!name || name.includes("*") || seen.has(name)) return;
    seen.add(name);
    fields.push(name);
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      field += char;
      if (char === "\\") {
        if (index + 1 < value.length) field += value[++index];
      } else if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      field += char;
    } else if (char === ",") {
      addField();
    } else {
      field += char;
    }
  }
  addField();
  return fields;
}

function stripCommentsAndStrings(query: string): string {
  let clean = "";
  for (let index = 0; index < query.length; ) {
    const char = query[index];
    if (char === "#") {
      while (index < query.length && query[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < query.length) {
        if (query[index] === "\\") index += 2;
        else if (query[index++] === quote) break;
      }
      clean += " ";
      continue;
    }
    clean += char;
    index += 1;
  }
  return clean;
}

function stripComments(query: string): string {
  let clean = "";
  let quote = "";
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (quote) {
      clean += char;
      if (char === "\\") {
        if (index + 1 < query.length) clean += query[++index];
      } else if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      clean += char;
    } else if (char === "#") {
      while (index + 1 < query.length && query[index + 1] !== "\n") index += 1;
    } else {
      clean += char;
    }
  }
  return clean;
}

export function insertFilter(query: string, filter: string): string {
  const pipe = findTopLevelPipe(query);
  if (pipe < 0) return `${query.trimEnd()} ${filter}`;
  return `${query.slice(0, pipe).trimEnd()} ${filter} ${query.slice(pipe)}`;
}

function findTopLevelPipe(query: string): number {
  let quote = "";
  let comment = false;
  for (let i = 0; i < query.length; i += 1) {
    const char = query[i];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "#") comment = true;
    else if (char === '"' || char === "'") quote = char;
    else if (char === "|") return i;
  }
  return -1;
}

function lastTopLevelPipe(query: string): number {
  let pipe = -1;
  let quote = "";
  let comment = false;
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "#") comment = true;
    else if (char === '"' || char === "'") quote = char;
    else if (char === "|") pipe = index;
  }
  return pipe;
}

export function quoteLogSQLValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
