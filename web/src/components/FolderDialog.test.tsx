import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderDialog } from "./FolderDialog";

afterEach(cleanup);

describe("FolderDialog", () => {
  it("creates a folder with a trimmed name", () => {
    const onCreate = vi.fn();
    render(<FolderDialog teamName="Platform" busy={false} error="" onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "  Incidents  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    expect(onCreate).toHaveBeenCalledWith("Incidents");
  });

  it("closes with Escape when creation is idle", () => {
    const onClose = vi.fn();
    render(<FolderDialog teamName="Platform" busy={false} error="" onClose={onClose} onCreate={vi.fn()} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
