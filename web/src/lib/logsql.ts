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

