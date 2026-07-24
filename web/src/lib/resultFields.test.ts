import { describe, expect, it } from "vitest";
import { filterResultRows, isHiddenResultField, parseHiddenResultFields } from "./resultFields";

describe("result field preferences", () => {
  it("matches exact fields and trailing prefix wildcards", () => {
    expect(isHiddenResultField("_stream", ["_stream", "meta*"])).toBe(true);
    expect(isHiddenResultField("metadata", ["_stream", "meta*"])).toBe(true);
    expect(isHiddenResultField("level", ["_stream", "meta*"])).toBe(false);
  });

  it("removes hidden fields recursively without mutating source rows", () => {
    const rows = [{
      _msg: "ready",
      file: "app.log",
      nested: { timestamp: "now", visible: true },
      events: [{ stream: "stderr", code: 200 }],
    }];

    expect(filterResultRows(rows, ["file", "stream", "timestamp"])).toEqual([{
      _msg: "ready",
      nested: { visible: true },
      events: [{ code: 200 }],
    }]);
    expect(rows[0].file).toBe("app.log");
    expect(rows[0].nested).toEqual({ timestamp: "now", visible: true });
  });

  it("parses comma- or line-separated fields and preserves first occurrence order", () => {
    expect(parseHiddenResultFields(" file, stream\nfile\nmeta* ")).toEqual(["file", "stream", "meta*"]);
    expect(parseHiddenResultFields(" \n ")).toEqual([]);
  });
});
