import type { FieldValue, Session, StreamEvent, Tenant } from "../types";

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

