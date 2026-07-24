import { expect, it } from "vitest";
import { shareTokenFromHash, shareURL } from "./share";

it("builds and reads an opaque share URL", () => {
  const token = "abcdefghijklmnopqrstuvwx12345678";
  const url = shareURL(token, { origin: "https://logs.example.com", pathname: "/" });
  const hash = new URL(url).hash;

  expect(shareTokenFromHash(hash)).toBe(token);
  expect(shareTokenFromHash("#share=client-encoded-query")).toBeNull();
});
