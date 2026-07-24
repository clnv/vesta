import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry, PersonalQuery, TeamLibrary, TeamQuery } from "../types";
import { Sidebar } from "./Sidebar";

afterEach(cleanup);

const star: TeamQuery = {
  id: "star-1",
  teamId: "team-1",
  title: "Recent errors",
  query: "_time:1h level:error",
  sourceId: "logs",
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

const privateStar: PersonalQuery = {
  id: "private-star-1",
  title: "My investigation",
  query: "_time:30m warning",
  sourceId: "logs",
  resultMode: "table",
  createdAt: "2026-07-23T00:00:00Z",
  updatedAt: "2026-07-23T00:00:00Z",
};

describe("Sidebar history", () => {
  it("renders a compact query preview and keeps the full query available", () => {
    const onRecall = vi.fn();
    const history: HistoryEntry = {
      id: "history-1",
      query: "_time:1h\n  | stats by (service) count()",
      sourceId: "logs",
      executedAt: new Date("2026-07-23T00:00:00Z").getTime(),
      status: "complete",
      elapsedMs: 27,
    };
    render(
      <Sidebar
        mode="history"
        onMode={vi.fn()}
        history={[history]}
        personalQueries={[]}
        teamLibraries={[]}
        onRecall={onRecall}
        onOpenStar={vi.fn()}
        onEditPersonalStar={vi.fn()}
        onEditTeamStar={vi.fn()}
        onCreateFolder={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    const preview = screen.getByText("_time:1h | stats by (service) count()");
    expect(preview).toHaveAttribute("title", history.query);
    expect(screen.getByText("27ms")).toBeInTheDocument();
    fireEvent.click(preview);
    expect(onRecall).toHaveBeenCalledWith(history);
  });
});

describe("Sidebar stars", () => {
  it("opens a selected team star for reuse", () => {
    const onOpenStar = vi.fn();
    render(
      <Sidebar
        mode="stars"
        onMode={vi.fn()}
        history={[]}
        personalQueries={[]}
        teamLibraries={libraries}
        onRecall={vi.fn()}
        onOpenStar={onOpenStar}
        onEditPersonalStar={vi.fn()}
        onEditTeamStar={vi.fn()}
        onCreateFolder={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Stars" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Starred queries" })).toBeInTheDocument();
    expect(screen.getByText("Private to you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Recent errors in a new tab" }));
    expect(onOpenStar).toHaveBeenCalledWith(star);
  });

  it("renames a star and moves it to another folder", async () => {
    const onEditTeamStar = vi.fn().mockResolvedValue(true);
    render(
      <Sidebar
        mode="stars"
        onMode={vi.fn()}
        history={[]}
        personalQueries={[]}
        teamLibraries={libraries}
        onRecall={vi.fn()}
        onOpenStar={vi.fn()}
        onEditPersonalStar={vi.fn()}
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

  it("shows and renames the current user's private stars without team folders", async () => {
    const onEditPersonalStar = vi.fn().mockResolvedValue(true);
    render(
      <Sidebar
        mode="stars"
        onMode={vi.fn()}
        history={[]}
        personalQueries={[privateStar]}
        teamLibraries={[]}
        onRecall={vi.fn()}
        onOpenStar={vi.fn()}
        onEditPersonalStar={onEditPersonalStar}
        onEditTeamStar={vi.fn()}
        onCreateFolder={vi.fn()}
        onClearHistory={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit My investigation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Star name" }), { target: { value: "My renamed investigation" } });
    expect(screen.queryByRole("combobox", { name: "Star folder" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save star" }));

    await waitFor(() => expect(onEditPersonalStar).toHaveBeenCalledWith(privateStar, "My renamed investigation"));
  });
});
