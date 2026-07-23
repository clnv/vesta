export const DEFAULT_QUERY = "_time:1h | sort by (_time) desc | limit 200";

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

export function quoteLogSQLValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
