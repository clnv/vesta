import type { ExplorerTab, TeamQuery } from "../types";

export function tabFromTeamStar(item: TeamQuery, id: string = crypto.randomUUID()): ExplorerTab {
  return {
    id,
    title: item.title,
    sourceId: item.sourceId,
    tenant: {
      accountId: item.tenantAccountId,
      projectId: item.tenantProjectId,
      name: item.tenantName,
    },
    query: item.query,
    lastExecutedQuery: "",
    resultMode: item.resultMode,
    status: "idle",
    rows: [],
    droppedRows: 0,
  };
}
