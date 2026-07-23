import { describe, expect, it } from "vitest";
import type { TeamQuery } from "../types";
import { tabFromTeamStar } from "./teamStars";

describe("tabFromTeamStar", () => {
  it("creates an editable, unexecuted copy in a new tab", () => {
    const star: TeamQuery = {
      id: "star-1",
      teamId: "team-1",
      folderId: "folder-1",
      title: "Recent errors",
      query: "_time:1h level:error",
      sourceId: "logs",
      tenantAccountId: "1",
      tenantProjectId: "2",
      tenantName: "Production",
      resultMode: "json",
      createdBy: "user-1",
      createdAt: "2026-07-23T00:00:00Z",
      updatedAt: "2026-07-23T00:00:00Z",
    };

    expect(tabFromTeamStar(star, "tab-copy")).toEqual({
      id: "tab-copy",
      title: "Recent errors",
      sourceId: "logs",
      tenant: { accountId: "1", projectId: "2", name: "Production" },
      query: "_time:1h level:error",
      lastExecutedQuery: "",
      resultMode: "json",
      status: "idle",
      rows: [],
      droppedRows: 0,
    });
  });
});
