export type ResultMode = "table" | "json" | "chart";
export type RunStatus = "idle" | "running" | "complete" | "truncated" | "error" | "cancelled";

export interface Source {
  id: string;
  name: string;
}

export interface UserSettings {
  hiddenResultFields: string[];
}

export interface Session {
  user: {
    subject: string;
    email: string;
    name: string;
    teams: Team[];
    isAdmin: boolean;
    settings: UserSettings;
  };
  sources: Source[];
  csrfToken: string;
  limits: {
    queryTimeoutMs: number;
    maxRows: number;
    maxBytes: number;
    maxQueries: number;
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
  query: string;
  lastExecutedQuery: string;
  resultMode: ResultMode;
  status: RunStatus;
  rows: Record<string, unknown>[];
  error?: string;
  warning?: string;
  stats?: RunStats;
  protected?: boolean;
  contextError?: string;
}

export type PersistedTab = Pick<ExplorerTab, "id" | "title" | "sourceId" | "query" | "lastExecutedQuery" | "resultMode" | "protected">;

export interface HistoryEntry {
  id: string;
  query: string;
  sourceId: string;
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
  query: string;
  sourceId: string;
  title: string;
  resultMode: ResultMode;
}

export interface Team {
  id: string;
  name: string;
}

export interface StarQuery {
  id: string;
  title: string;
  query: string;
  sourceId: string;
  resultMode: ResultMode;
  createdAt: string;
  updatedAt: string;
}

export type PersonalQuery = StarQuery;

export interface TeamQuery extends StarQuery {
  teamId: string;
  folderId?: string;
  createdBy: string;
}

export interface TeamFolder {
  id: string;
  teamId: string;
  name: string;
  queries: TeamQuery[];
  createdAt: string;
}

export interface TeamLibrary {
  team: Team;
  folders: TeamFolder[];
  queries: TeamQuery[];
}

export interface StarLibrary {
  self: PersonalQuery[];
  teams: TeamLibrary[];
}

export interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
}

export interface Directory {
  users: DirectoryUser[];
  teams: Team[];
  memberships: Array<{ userId: string; teamId: string }>;
}

export interface PermissionSource {
  id: string;
  name: string;
  roles: string[];
}

export interface PermissionCatalog {
  roles: string[];
  sources: PermissionSource[];
}

export interface UpdateDirectoryUserInput {
  email: string;
  name: string;
  roles: string[];
  isAdmin: boolean;
  disabled: boolean;
  teamIds: string[];
}
