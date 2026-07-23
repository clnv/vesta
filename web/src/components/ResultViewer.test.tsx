import { fireEvent, render, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ResultViewer } from "./ResultViewer";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 34,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 34 })),
    measureElement: vi.fn(),
  }),
}));

it("uses the same explicit width for the table header and virtualized rows", () => {
  const { container } = render(
    <ResultViewer
      mode="table"
      onCopy={vi.fn()}
      rows={[{ _time: "0", _msg: "hello", trace_id: "a-very-long-trace-id" }]}
    />,
  );

  const header = container.querySelector<HTMLElement>(".table-header");
  const canvas = container.querySelector<HTMLElement>(".virtual-canvas");

  expect(header?.style.width).toBe("max(100%, 484px)");
  expect(canvas?.style.width).toBe(header?.style.width);
  expect(header?.style.gridTemplateColumns).toBe("34px minmax(150px, 1fr) minmax(150px, 1fr) minmax(150px, 1fr)");
});

it("resizes a table column with its accessible header handle", () => {
  const { container } = render(
    <ResultViewer mode="table" onCopy={vi.fn()} rows={[{ _time: "0", _msg: "hello" }]} />,
  );
  const view = within(container);
  const timeResizer = view.getByRole("separator", { name: "Resize _time column" });

  fireEvent.keyDown(timeResizer, { key: "ArrowRight" });

  expect(container.querySelector<HTMLElement>(".table-header")?.style.gridTemplateColumns)
    .toBe("34px 166px minmax(150px, 1fr)");
  expect(container.querySelector<HTMLElement>(".table-row")?.style.gridTemplateColumns)
    .toBe("34px 166px minmax(150px, 1fr)");

  const pointerEvent = (type: string, clientX: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      clientX: { value: clientX },
    });
    fireEvent(timeResizer, event);
  };
  pointerEvent("pointerdown", 100);
  pointerEvent("pointermove", 150);
  pointerEvent("pointerup", 150);

  expect(container.querySelector<HTMLElement>(".table-header")?.style.gridTemplateColumns)
    .toBe("34px 216px minmax(150px, 1fr)");
});

it("expands a table row to its formatted JSON payload", () => {
  const row = { _time: "0", _msg: "hello", level: "info" };
  const onCopy = vi.fn();
  const { container } = render(
    <ResultViewer
      mode="table"
      onCopy={onCopy}
      rows={[row]}
    />,
  );

  const view = within(container);
  const expand = view.getByRole("button", { name: "Expand row 1 JSON" });
  fireEvent.click(expand);

  expect(view.getByRole("button", { name: "Collapse row 1 JSON" })).toHaveAttribute("aria-expanded", "true");
  expect(container.querySelector(".table-row-json")).toHaveTextContent('"level": "info"');

  fireEvent.click(view.getByRole("button", { name: "Copy row 1 full JSON" }));
  expect(onCopy).toHaveBeenCalledWith(JSON.stringify(row, null, 2));
});

it("expands and copies one complete field value", () => {
  const row = { _time: "0", payload: { message: "a long value", attempts: [1, 2, 3] } };
  const onCopy = vi.fn();
  const { container } = render(<ResultViewer mode="table" onCopy={onCopy} rows={[row]} />);
  const view = within(container);

  const field = view.getByRole("button", { name: "Inspect payload in row 1" });
  fireEvent.click(field);

  expect(field).toHaveAttribute("aria-expanded", "true");
  expect(container.querySelector(".table-field-detail")).toHaveTextContent('"message": "a long value"');

  const copyValue = view.getByRole("button", { name: "Copy payload from row 1" });
  expect(container.querySelector(".table-field-detail-header")?.lastElementChild).toBe(copyValue);
  fireEvent.click(copyValue);
  expect(onCopy).toHaveBeenCalledWith(JSON.stringify(row.payload, null, 2));

  fireEvent.click(field);
  expect(container.querySelector(".table-field-detail")).not.toBeInTheDocument();
});
