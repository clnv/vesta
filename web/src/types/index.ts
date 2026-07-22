export type ResultMode = "log" | "table" | "json";
export type RunStatus = "idle" | "running" | "tailing" | "complete" | "truncated" | "error" | "cancelled";

export interface Tenant {
  accountId: string;
  projectId: string;
  name: string;
}

export interface Source {
  id: string;
  name: string;
  tenants: Tenant[];
}

export interface Session {
  user: { subject: string; email: string; name: string };
  sources: Source[];
  csrfToken: string;
  limits: {
    queryTimeoutMs: number;
    maxRows: number;
    maxBytes: number;
    maxQueries: number;
    maxTails: number;
  };
}

export interface RunStats {
  requestId?: string;
  rows: number;
  bytes: number;
  elapsedMs: number;
  victoriaDurationSeconds?: string;
  reason?: string;
}

export interface ExplorerTab {
  id: string;
  title: string;
  sourceId: string;
  tenant: Tenant;
  query: string;
  lastExecutedQuery: string;
  resultMode: ResultMode;
  status: RunStatus;
  rows: Record<string, unknown>[];
  droppedRows: number;
  error?: string;
  warning?: string;
  stats?: RunStats;
  protected?: boolean;
  contextError?: string;
}

export type PersistedTab = Pick<ExplorerTab, "id" | "title" | "sourceId" | "tenant" | "query" | "lastExecutedQuery" | "resultMode" | "protected">;

export interface HistoryEntry {
  id: string;
  query: string;
  sourceId: string;
  tenant: Tenant;
  executedAt: number;
  status: RunStatus;
  elapsedMs?: number;
}

export interface StreamEvent {
  type: "meta" | "row" | "end" | "error";
  requestId?: string;
  row?: Record<string, unknown>;
  status?: RunStatus;
  reason?: string;
  message?: string;
  rows?: number;
  bytes?: number;
  elapsedMs?: number;
  victoriaDurationSeconds?: string;
  warning?: string;
}

export interface FieldValue {
  value: string;
  hits: number;
}

export interface SharePayload {
  v: 1;
  query: string;
  sourceId: string;
  tenant: Tenant;
  title: string;
  resultMode: ResultMode;
}

