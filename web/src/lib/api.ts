import type {
  Directory, DirectoryUser, FieldValue, Session, ShareAudience, SharePayload,
  Team, TeamFolder, TeamLibrary, TeamQuery, StreamEvent, Tenant,
} from "../types";

export class APIError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function parseError(response: Response): Promise<string> {
  try {
    const value = await response.json() as { error?: string };
    return value.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

export async function getSession(): Promise<Session> {
  const response = await fetch("/api/v1/session", { credentials: "same-origin" });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
  return response.json() as Promise<Session>;
}

export async function login(email: string, password: string): Promise<void> {
  const response = await fetch("/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
}

async function postJSON<T>(path: string, body: unknown, csrfToken: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
  return response.json() as Promise<T>;
}

export async function createShare(payload: SharePayload, audience: ShareAudience, csrfToken: string): Promise<{ token: string; expiresAt: number }> {
  return postJSON("/api/v1/shares", { payload, audience }, csrfToken);
}

export async function openShare(token: string, csrfToken: string): Promise<{ payload: SharePayload; expiresAt: number }> {
  return postJSON("/api/v1/shares/open", { token }, csrfToken);
}

export async function getTeamLibrary(): Promise<TeamLibrary[]> {
  const response = await fetch("/api/v1/team-library", { credentials: "same-origin" });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
  const payload = await response.json() as { teams?: TeamLibrary[] };
  return payload.teams ?? [];
}

export async function createTeamFolder(teamId: string, name: string, csrfToken: string): Promise<TeamFolder> {
  return postJSON("/api/v1/team-folders", { teamId, name }, csrfToken);
}

export async function createTeamQuery(teamId: string, folderId: string, payload: SharePayload, csrfToken: string): Promise<TeamQuery> {
  return postJSON("/api/v1/team-queries", { teamId, folderId, payload }, csrfToken);
}

export async function getDirectory(): Promise<Directory> {
  const response = await fetch("/api/v1/admin/directory", { credentials: "same-origin" });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
  return response.json() as Promise<Directory>;
}

export async function createDirectoryUser(
  input: { email: string; name: string; password: string; roles: string[]; isAdmin: boolean },
  csrfToken: string,
): Promise<DirectoryUser> {
  return postJSON("/api/v1/admin/users", input, csrfToken);
}

export async function createDirectoryTeam(name: string, csrfToken: string): Promise<Team> {
  return postJSON("/api/v1/admin/teams", { name }, csrfToken);
}

export async function addDirectoryMembership(userId: string, teamId: string, csrfToken: string): Promise<void> {
  const response = await fetch("/api/v1/admin/memberships", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ userId, teamId }),
  });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
}

export async function changePassword(currentPassword: string, newPassword: string, csrfToken: string): Promise<void> {
  const response = await fetch("/api/v1/account/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
}

export interface QueryInput { sourceId: string; tenant: Tenant; query: string; field?: string }

export async function streamQuery(
  path: "/api/v1/query" | "/api/v1/tail",
  input: QueryInput,
  csrfToken: string,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
  if (!response.body) throw new APIError("Streaming response is unavailable", 500);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as StreamEvent);
    if (done) break;
  }
  if (pending.trim()) onEvent(JSON.parse(pending) as StreamEvent);
}

export async function fetchFields(input: QueryInput, csrfToken: string, field?: string): Promise<FieldValue[]> {
  const response = await fetch(field ? "/api/v1/field-values" : "/api/v1/fields", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(field ? { ...input, field } : input),
  });
  if (!response.ok) throw new APIError(await parseError(response), response.status);
  const payload = await response.json() as { values?: FieldValue[] };
  return payload.values ?? [];
}
