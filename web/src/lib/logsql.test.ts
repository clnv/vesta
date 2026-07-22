import { describe, expect, it } from "vitest";
import { hasTimeFilter, insertFilter, quoteLogSQLValue } from "./logsql";

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

