import type { ExplorerTab, StarQuery } from "../types";

export function tabFromTeamStar(item: StarQuery, id: string = crypto.randomUUID()): ExplorerTab {
  return {
    id,
    title: item.title,
    sourceId: item.sourceId,
    query: item.query,
    lastExecutedQuery: "",
    resultMode: item.resultMode,
    status: "idle",
    rows: [],
  };
}
