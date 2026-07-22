import { expect, it } from "vitest";
import { decodeShare, encodeShare, shareURL } from "./share";
import type { SharePayload } from "../types";

it("round trips a versioned share fragment", () => {
  const payload: SharePayload = {
    v: 1,
    query: "_time:1h error | limit 20",
    sourceId: "prod",
    tenant: { accountId: "12", projectId: "34", name: "payments" },
    title: "Errors",
    resultMode: "table",
  };
  const encoded = encodeShare(payload);
  expect(decodeShare(encoded)).toEqual(payload);
  expect(shareURL(payload, { origin: "https://logs.example.com", pathname: "/" })).toContain("#share=");
});

