import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamLibrary, TeamQuery } from "../types";
import { Sidebar } from "./Sidebar";

afterEach(cleanup);

const star: TeamQuery = {
  id: "star-1",
  teamId: "team-1",
  title: "Recent errors",
  query: "_time:1h level:error",
  sourceId: "logs",
  tenantAccountId: "1",
  tenantProjectId: "2",
  tenantName: "Production",
  resultMode: "table",
  createdBy: "user-1",
  createdAt: "2026-07-23T00:00:00Z",
  updatedAt: "2026-07-23T00:00:00Z",
};

const libraries: TeamLibrary[] = [{
  team: { id: "team-1", name: "Platform" },
  folders: [{
    id: "folder-1",
    teamId: "team-1",
    name: "Incidents",
    queries: [],
    createdAt: "2026-07-23T00:00:00Z",
  }],
  queries: [star],
}];

describe("Sidebar team stars", () => {
  it("opens a selected team star for reuse", () => {
    const onOpenTeamStar = vi.fn();
    render(
      <Sidebar
        mode="stars"
        onMode={vi.fn()}
        history={[]}
        teamLibraries={libraries}
        onRecall={vi.fn()}
        onOpenTeamStar={onOpenTeamStar}
        onEditTeamStar={vi.fn()}
        onCreateFolder={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Stars" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Team stars" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Recent errors in a new tab" }));
    expect(onOpenTeamStar).toHaveBeenCalledWith(star);
  });

  it("renames a star and moves it to another folder", async () => {
    const onEditTeamStar = vi.fn().mockResolvedValue(true);
    render(
      <Sidebar
        mode="stars"
        onMode={vi.fn()}
        history={[]}
        teamLibraries={libraries}
        onRecall={vi.fn()}
        onOpenTeamStar={vi.fn()}
        onEditTeamStar={onEditTeamStar}
        onCreateFolder={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Recent errors" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Star name" }), { target: { value: "Priority errors" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Star folder" }), { target: { value: "folder-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save star" }));

    await waitFor(() => expect(onEditTeamStar).toHaveBeenCalledWith(star, "Priority errors", "folder-1"));
  });
});
