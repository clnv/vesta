import { expect, it } from "vitest";
import { appendToRing } from "./ring";

it("keeps the newest live-tail rows and reports every dropped row", () => {
  expect(appendToRing([1, 2, 3], [4, 5], 4)).toEqual({ rows: [2, 3, 4, 5], dropped: 1 });
  expect(appendToRing([2, 3, 4, 5], [6, 7, 8], 4)).toEqual({ rows: [5, 6, 7, 8], dropped: 3 });
});
