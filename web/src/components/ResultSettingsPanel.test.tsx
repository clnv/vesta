import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResultSettingsPanel } from "./ResultSettingsPanel";

const api = vi.hoisted(() => ({
  updateUserSettings: vi.fn(),
}));

vi.mock("../lib/api", () => api);

beforeEach(() => {
  vi.clearAllMocks();
  api.updateUserSettings.mockResolvedValue({ hiddenResultFields: ["file", "trace*"] });
});

afterEach(cleanup);

it("saves normalized personal hidden fields", async () => {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onMessage = vi.fn();
  render(
    <ResultSettingsPanel
      settings={{ hiddenResultFields: ["_stream", "file"] }}
      csrfToken="csrf"
      onClose={onClose}
      onSaved={onSaved}
      onMessage={onMessage}
    />,
  );

  fireEvent.change(screen.getByLabelText("Add a field or prefix"), {
    target: { value: " trace*, file " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Show _stream in results" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(api.updateUserSettings).toHaveBeenCalledWith(["file", "trace*"], "csrf"));
  expect(onSaved).toHaveBeenCalledWith({ hiddenResultFields: ["file", "trace*"] });
  expect(onMessage).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it("restores the documented defaults in the editor", () => {
  render(
    <ResultSettingsPanel
      settings={{ hiddenResultFields: [] }}
      csrfToken="csrf"
      onClose={vi.fn()}
      onSaved={vi.fn()}
      onMessage={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));

  expect(screen.getByText("5 hidden fields")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show _stream in results" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show _stream_id in results" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show file in results" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show stream in results" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show timestamp in results" })).toBeInTheDocument();
});
