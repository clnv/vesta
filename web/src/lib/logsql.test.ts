import { describe, expect, it } from "vitest";
import {
  columnsFromQuery, DEFAULT_QUERY, hasTimeFilter, insertFilter, queryAtCursor, quoteLogSQLValue,
  renderDirectiveFromQuery,
} from "./logsql";

it("formats the starter query as a readable pipeline", () => {
  expect(DEFAULT_QUERY).toBe("_time:1h\n| sort by (_time) desc\n| limit 200");
});

describe("queryAtCursor", () => {
  it("returns the blank-line-delimited query under the cursor", () => {
    const document = [
      "_time:5m error",
      "| limit 10",
      "",
      "_time:1h warning",
      "| stats count()",
    ].join("\n");

    expect(queryAtCursor(document, document.indexOf("error"))).toBe("_time:5m error\n| limit 10");
    expect(queryAtCursor(document, document.indexOf("warning"))).toBe("_time:1h warning\n| stats count()");
  });

  it("keeps pipeline continuations separated by blank lines in one query", () => {
    const document = [
      "_time:5m",
      "",
      "# aggregate the matching logs",
      "| stats count()",
      "",
      "_time:1h warning",
    ].join("\n");

    expect(queryAtCursor(document, document.indexOf("stats"))).toBe([
      "_time:5m",
      "",
      "# aggregate the matching logs",
      "| stats count()",
    ].join("\n"));
  });

  it("uses unquoted semicolons as explicit query terminators", () => {
    const document = `_time:5m _msg:"first;value"; _time:1h warning;`;

    expect(queryAtCursor(document, document.indexOf("first"))).toBe(`_time:5m _msg:"first;value"`);
    expect(queryAtCursor(document, document.indexOf("warning"))).toBe("_time:1h warning");
  });

  it("supports mixing blank-line and semicolon terminators", () => {
    const document = "_time:5m error\n\n_time:1h warning;\n\n_time:24h critical";

    expect(queryAtCursor(document, document.indexOf("error"))).toBe("_time:5m error");
    expect(queryAtCursor(document, document.indexOf("warning"))).toBe("_time:1h warning");
    expect(queryAtCursor(document, document.indexOf("critical"))).toBe("_time:24h critical");
  });

  it("ignores semicolons in comments and backtick strings", () => {
    const document = [
      "_time:5m `first;value` # ignored;",
      "| limit 10",
      "",
      "_time:1h warning",
    ].join("\n");

    expect(queryAtCursor(document, document.indexOf("limit"))).toBe([
      "_time:5m `first;value` # ignored;",
      "| limit 10",
    ].join("\n"));
    expect(queryAtCursor(document, document.indexOf("warning"))).toBe("_time:1h warning");
  });

  it("returns no query when the cursor is on a separator", () => {
    const document = "_time:5m\n\n_time:1h";
    expect(queryAtCursor(document, document.indexOf("\n\n") + 1)).toBe("");
  });
});

describe("hasTimeFilter", () => {
  it.each([
    ["_time:1h error", true],
    ["_time : [2026-01-01Z, 2026-01-02Z)", true],
    ["error # _time:1h", false],
    ['"_time:1h"', false],
    ["fields _time, _msg", false],
    ["foo_time:1h", false],
  ])("validates %s", (query, expected) => expect(hasTimeFilter(query)).toBe(expected));
});

it("inserts filters before the first pipe", () => {
  expect(insertFilter("_time:1h | limit 20", 'host:="api"')).toBe('_time:1h host:="api" | limit 20');
  expect(quoteLogSQLValue('a"b')).toBe('"a\\"b"');
});

describe("columnsFromQuery", () => {
  it("preserves the last explicit fields or keep stage order", () => {
    expect(columnsFromQuery(`
      _time:1h
      | fields ignored
      | sort by (_time) desc
      | keep _time, level, _msg
    `)).toEqual(["_time", "level", "_msg"]);
  });

  it("ignores comments, quoted pipes, duplicates, and wildcard selectors", () => {
    expect(columnsFromQuery(`
      _time:1h _msg:"fields fake | fields wrong"
      # | fields commented
      | fields _time, "http.status", _time, *
    `)).toEqual(["_time", "http.status"]);
  });
});

describe("renderDirectiveFromQuery", () => {
  it("extracts a terminal Kusto-style render operator and its properties", () => {
    expect(renderDirectiveFromQuery(`
      _time:1h
      | stats by (_time:5m) count() as requests
      | render timechart with (title="Requests | 5m", xcolumn=_time, ycolumns=requests, errors, legend=hidden)
    `)).toEqual({
      visualization: "timechart",
      supported: true,
      properties: {
        title: "Requests | 5m",
        xcolumn: "_time",
        ycolumns: "requests, errors",
        legend: "hidden",
      },
      executableQuery: `
      _time:1h
      | stats by (_time:5m) count() as requests`,
    });
  });

  it("ignores render text in strings, comments, and non-terminal stages", () => {
    expect(renderDirectiveFromQuery('_time:1h _msg:"| render piechart" | limit 10')).toBeNull();
    expect(renderDirectiveFromQuery("_time:1h | limit 10 # | render piechart")).toBeNull();
    expect(renderDirectiveFromQuery("_time:1h | render timechart | limit 10")).toBeNull();
  });

  it("recognizes unsupported visualizations so they are not sent upstream", () => {
    expect(renderDirectiveFromQuery("_time:1h | stats count() | render treemap")).toMatchObject({
      visualization: "treemap",
      supported: false,
      executableQuery: "_time:1h | stats count()",
    });
  });
});
