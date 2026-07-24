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

it("copies chart source data as a table", () => {
  const text = formatRows(
    [{ _time: "2026-07-23T00:00:00Z", requests: 12 }],
    "chart",
    "clipboard",
    ["_time", "requests"],
  );

  expect(text).toBe("_time\trequests\n2026-07-23T00:00:00Z\t12");
});

it("combines a share link, query, and results", () => {
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

it("embeds a rendered chart image in rich sharing with source data as the plain-text fallback", () => {
  const bundle = shareBundle({
    query: "_time:1h | stats count() logs | render columnchart",
    link: "https://logs.example.com/#share=protected",
    rows: [{ level: "error", logs: 12 }],
    mode: "chart",
    chartImageDataURL: "data:image/png;base64,chart",
  });

  expect(bundle.html).toContain('src="data:image/png;base64,chart"');
  expect(bundle.html).toContain('alt="Rendered query chart"');
  expect(bundle.html).not.toContain("<table");
  expect(bundle.text).toContain("Chart source data: 1 rows");
  expect(bundle.text).toContain("level\tlogs\nerror\t12");
});

it("includes only the selected share content", () => {
  const queryOnly = shareBundle({
    query: "_time:1h error",
    link: "",
    rows: [{ level: "error" }],
    mode: "table",
    include: { link: false, query: true, results: false },
  });
  expect(queryOnly.text).toBe("_time:1h error");
  expect(queryOnly.html).toContain("_time");
  expect(queryOnly.html).not.toContain("<table");
  expect(queryOnly.html).not.toContain("<a href=");

  const linkAndResults = shareBundle({
    query: "_time:1h error",
    link: "https://logs.example.com/#share=system",
    rows: [{ level: "error" }],
    mode: "table",
    include: { link: true, query: false, results: true },
  });
  expect(linkAndResults.text).toContain("[Open shared query](https://logs.example.com/#share=system)");
  expect(linkAndResults.text).not.toContain("```logsql");
  expect(linkAndResults.text).toContain("Results: 1 rows");

  const linkOnly = shareBundle({
    query: "_time:1h error",
    link: "https://logs.example.com/#share=system",
    rows: [],
    mode: "table",
    include: { link: true, query: false, results: false },
  });
  expect(linkOnly.text).toBe("https://logs.example.com/#share=system");
});

it("escapes untrusted query text while applying LogsQL highlighting", () => {
  const highlighted = highlightLogSQL('_time:1h | filter _msg:"<script>" # <unsafe>');

  expect(highlighted).not.toContain("<script>");
  expect(highlighted).toContain("&lt;script&gt;");
  expect(highlighted).toContain('<span style="color:#7c3aed;font-weight:600">filter</span>');
  expect(highlighted).toContain('<span style="color:#64748b;font-style:italic"># &lt;unsafe&gt;</span>');
});
