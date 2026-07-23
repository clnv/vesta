import { expect, it } from "vitest";
import { formatRows, highlightLogSQL, shareBundle } from "./format";

it("uses an explicit column order for table exports", () => {
  const csv = formatRows(
    [{ _time: "2026-07-23T00:00:00Z", _msg: "hello", level: "info" }],
    "table",
    "csv",
    ["_time", "level", "_msg"],
  );

  expect(csv.split("\n")[0]).toBe("_time,level,_msg");
});

it("combines connection context, protected link, query, and results for sharing", () => {
  const bundle = shareBundle({
    query: "_time:1h error | limit 2",
    link: "https://logs.example.com/#share=protected",
    rows: [
      { _time: "2026-07-23T00:00:00Z", _msg: "first" },
      { _time: "2026-07-23T00:00:01Z", _msg: "second" },
    ],
    mode: "table",
  });

  expect(bundle.truncated).toBe(false);
  expect(bundle.text).not.toContain("Vesta LogsQL share");
  expect(bundle.text).not.toContain("Source:");
  expect(bundle.text).not.toContain("Tenant:");
  expect(bundle.text).toContain("[Query](https://logs.example.com/#share=protected)");
  expect(bundle.text).toContain("```logsql\n_time:1h error | limit 2\n```");
  expect(bundle.text).toContain("Results: 2 rows\n```tsv\n_time\t_msg");
  expect(bundle.text).toContain("2026-07-23T00:00:01Z\tsecond");
  expect(bundle.html).toContain('<a href="https://logs.example.com/#share=protected"');
  expect(bundle.html).toContain(">[Query]</a>");
  expect(bundle.html).toContain("<table");
  expect(bundle.html).toContain(">_time</th>");
  expect(bundle.html).toContain(">second</td>");
  expect(bundle.html).toContain('<span style="color:#7c3aed;font-weight:600">limit</span>');
});

it("escapes untrusted query text while applying LogsQL highlighting", () => {
  const highlighted = highlightLogSQL('_time:1h | filter _msg:"<script>" # <unsafe>');

  expect(highlighted).not.toContain("<script>");
  expect(highlighted).toContain("&lt;script&gt;");
  expect(highlighted).toContain('<span style="color:#7c3aed;font-weight:600">filter</span>');
  expect(highlighted).toContain('<span style="color:#64748b;font-style:italic"># &lt;unsafe&gt;</span>');
});
