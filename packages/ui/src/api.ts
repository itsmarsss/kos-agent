/** Typed client for the KOS dashboard API. */

export interface Status {
  halted: boolean;
  queueDepth: number;
  crons: number;
  pendingApprovals: number;
  projects?: number;
  pages?: number;
  discord?: boolean;
  pid?: number;
  workspace?: string;
}

export interface PendingAction {
  id: number;
  tool: string;
  args: string;
  reason: string | null;
  requestedAt: number;
}

export interface Project {
  id?: number;
  slug: string;
  name: string;
  type: string;
  status: string;
  description?: string | null;
  module?: string | null;
  lastTouchedAt: number;
  createdAt?: number;
}

export interface CronJob {
  id: number;
  name: string;
  schedule: string;
  type: string;
  enabled: boolean;
  query?: string | null;
  condition?: { test: string } | null;
  actions?: Array<{ tool: string; args: Record<string, unknown> }> | null;
  prompt?: string | null;
  projectSlug?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface RunRecord {
  id: number;
  kind: string;
  status: string;
  error: string | null;
  startedAt: number;
  ref?: string | null;
  finishedAt?: number | null;
  durationMs?: number | null;
}

export interface AuditRecord {
  id: number;
  tool: string;
  args: string;
  result: string;
  isError: boolean;
  riskTier?: string | null;
  userId?: string | null;
  createdAt: number;
}

export interface PageSummary {
  id: string;
  projectSlug: string;
  title: string;
  path: string;
  updatedAt: number;
}

export interface PagePayload {
  record: PageSummary;
  spec: import("@kos/shared").PageSpec;
  data: Record<number, Record<string, unknown>[]>;
  /** Per-widget display-query failures, keyed by widget index. */
  errors?: Record<number, string>;
}

/** The guarded mutation path shared by every write-capable widget. */
export type MutateOp = "insert" | "update" | "delete";

/** Identifies the row an update/delete targets. */
export interface MutateKey {
  column: string;
  value: unknown;
}

/**
 * A widget mutation request. The server resolves the target table and the
 * editable columns from the stored page spec, so the client never sends them:
 * a widget can only ever mutate what its own spec declared.
 */
export interface MutateRequest {
  pageId: string;
  widgetIndex: number;
  op: MutateOp;
  values?: Record<string, unknown>;
  key?: MutateKey;
}

export interface MutateResult {
  ok: boolean;
  changes?: number;
}

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  channel: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface ChatTurn {
  role: "you" | "kos";
  text: string;
}

export interface FactRow {
  id?: number;
  key: string;
  value: string;
  kind: string;
  source?: string | null;
  updatedAt?: number;
  createdAt?: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path}: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => get<Status>("/api/status"),
  approvals: () => get<PendingAction[]>("/api/approvals"),
  projects: () => get<Project[]>("/api/projects"),
  setProjectStatus: (slug: string, status: string) =>
    post<Project>("/api/projects/status", { slug, status }),
  crons: () => get<CronJob[]>("/api/crons"),
  setCronEnabled: (id: number, enabled: boolean) =>
    post<{ id: number; enabled: boolean }>("/api/crons/enable", {
      id,
      enabled,
    }),
  deleteCron: (id: number) =>
    post<{ id: number; removed: boolean }>("/api/crons/delete", { id }),
  failed: (limit = 100) => get<RunRecord[]>(`/api/failed?limit=${limit}`),
  runs: (limit = 100, failedOnly = false) =>
    get<RunRecord[]>(
      `/api/runs?limit=${limit}${failedOnly ? "&failed=1" : ""}`,
    ),
  activity: (limit = 100) =>
    get<{ tools: AuditRecord[]; runs: RunRecord[] }>(
      `/api/activity?limit=${limit}`,
    ),
  pages: (project?: string) =>
    get<PageSummary[]>(
      project ? `/api/pages?project=${encodeURIComponent(project)}` : "/api/pages",
    ),
  page: (id: string) => get<PagePayload>(`/api/pages/${encodeURIComponent(id)}`),
  mutate: (req: MutateRequest) => post<MutateResult>("/api/mutate", req),
  conversations: () => get<Conversation[]>("/api/conversations"),
  conversation: (id: string) =>
    get<{ id: string; messages: ChatTurn[] }>(
      `/api/conversations/${encodeURIComponent(id)}/messages`,
    ),
  newConversation: (title?: string) =>
    post<Conversation>("/api/conversations/new", title ? { title } : {}),
  renameConversation: (id: string, title: string) =>
    post<Conversation>("/api/conversations/rename", { id, title }),
  archiveConversation: (id: string) =>
    post<Conversation>("/api/conversations/archive", { id, archived: true }),
  deleteConversation: (id: string) =>
    post<{ id: string; removed: boolean }>("/api/conversations/delete", { id }),
  memory: (limit = 200) =>
    get<{ facts: FactRow[] }>(`/api/memory?limit=${limit}`),
  saveMemory: (key: string, value: string, kind: "fact" | "preference" = "fact") =>
    post<FactRow>("/api/memory", { key, value, kind }),
  deleteMemory: (key: string) =>
    post<{ key: string; removed: boolean }>("/api/memory/delete", { key }),
  approve: (id: number) =>
    post<{ ok: boolean; message: string; reply?: string }>("/api/approve", {
      id,
    }),
  deny: (id: number) =>
    post<{ ok: boolean; message: string; reply?: string }>("/api/deny", { id }),
  setKill: (halted: boolean) => post<Status>("/api/kill", { halted }),
  message: (text: string, sessionId?: string) =>
    post<{ reply: string }>("/api/message", {
      text,
      ...(sessionId ? { sessionId } : {}),
    }),
  snapshot: (message?: string) =>
    post<{ sha: string | null }>("/api/snapshot", message ? { message } : {}),
  clear: (sessionId?: string) =>
    post<{ cleared: string }>(
      "/api/clear",
      sessionId ? { sessionId } : {},
    ),
};
