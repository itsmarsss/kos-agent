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
  orchestratorId?: string;
  /** Which model answers each task class, when the router can say. */
  routes?: Record<
    string,
    { provider: string; model: string; effort?: string; maxTokens?: number }
  > | null;
}

/** A file the owner attached, as bytes the model can be shown. */
export interface Attachment {
  name: string;
  mediaType: string;
  data: string;
}

export interface TaskModelSetting {
  model?: string;
  effort?: string;
  maxTokens?: number;
}

/** Model choices per task class, as edited in Settings. */
export type ModelSettings = Partial<Record<"reasoning" | "cheap", TaskModelSetting>>;

export interface PendingAction {
  id: number;
  tool: string;
  args: string;
  reason: string | null;
  /** The conversation that asked, so a decision can be taken where it lives. */
  conversationId: string | null;
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
  /** Standing instructions for this conversation, when it is a scoped agent. */
  brief: string | null;
  /** null is the full toolkit; an array is an exact scope, empty included. */
  toolAllow: string[] | null;
  /** The orchestrator is a conversation, but not one of the owner's chats. */
  kind?: "orchestrator" | "chat";
  /** What the thread is doing, so the list can say rather than look idle. */
  activity?: "working" | "needs-you" | "idle";
}

export interface ChatTurn {
  role: "you" | "kos";
  text: string;
}

export type ChatEvent =
  | {
      /** What the model worked out before answering, kept so it can be reread. */
      kind: "reasoning";
      text: string;
    }
  | {
      kind: "message";
      role: "you" | "kos" | "system";
      text: string;
      /** What came with this turn: images and text files, with their names. */
      attachments?: { name: string; src?: string; text?: string }[];
    }
  | {
      kind: "tool";
      name: string;
      summary: string;
      args: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      /** Set when the call is waiting on approval rather than having run. */
      pendingId?: string;
    };

export interface DirEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  modifiedAt: number;
}

export interface FileContent {
  path: string;
  size: number;
  modifiedAt: number;
  text?: string;
  omitted?: "binary" | "too-large";
  language: string;
}

export interface SiteInfo {
  name: string;
  hasIndex: boolean;
  modifiedAt: number;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface FactRow {
  id?: number;
  key: string;
  value: string;
  kind: string;
  source?: string | null;
  tags?: string[];
  pinned?: boolean;
  updatedAt?: number;
  createdAt?: number;
}

/** The server's own sentence when it sent one, else something serviceable. */
async function readError(res: Response, path: string): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return text.trim() || `${path} failed (${res.status})`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await readError(res, path));
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // The server sends {"error": "..."} written for a reader; pasting the raw
    // body meant a chat showed `/api/message: 400 {"error":"..."}` instead.
    throw new Error(await readError(res, path));
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => get<Status>("/api/status"),
  approvals: () => get<PendingAction[]>("/api/approvals"),
  modelSettings: () =>
    get<{
      routes: Record<
        string,
        { provider: string; model: string; effort?: string; maxTokens?: number }
      > | null;
      saved: ModelSettings;
      efforts: string[];
    }>("/api/settings/models"),
  saveModelSettings: (settings: ModelSettings) =>
    post<{ saved: ModelSettings }>("/api/settings/models", settings),
  availableModels: () => get<{ models: string[] }>("/api/models"),
  projects: () => get<Project[]>("/api/projects"),
  setProjectStatus: (slug: string, status: string) =>
    post<Project>("/api/projects/status", { slug, status }),
  crons: () => get<CronJob[]>("/api/crons"),
  createCron: (job: Record<string, unknown>) =>
    post<CronJob>("/api/crons/create", job),
  updateCron: (job: Record<string, unknown>) =>
    post<CronJob>("/api/crons/update", job),
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
  conversations: (includeArchived = false) =>
    get<Conversation[]>(
      includeArchived ? "/api/conversations?archived=1" : "/api/conversations",
    ),
  orchestrator: (text: string, attachments?: Attachment[]) =>
    post<{ reply: string; conversationId: string }>("/api/orchestrator", {
      text,
      ...(attachments?.length ? { attachments } : {}),
    }),
  conversation: (id: string) =>
    get<{ id: string; messages: ChatTurn[]; events: ChatEvent[] }>(
      `/api/conversations/${encodeURIComponent(id)}/messages`,
    ),
  tools: () => get<ToolInfo[]>("/api/tools"),
  files: (path = ".") =>
    get<{ path: string; entries: DirEntry[] }>(
      `/api/files?path=${encodeURIComponent(path)}`,
    ),
  file: (path: string) =>
    get<FileContent>(`/api/file?path=${encodeURIComponent(path)}`),
  /**
   * Image bytes as an object URL. Fetched rather than pointed at with a src so
   * the request carries whatever the rest of the client carries; the caller
   * revokes the URL when it is done with it.
   */
  imageUrl: async (path: string): Promise<string> => {
    const url = `/api/file/raw?path=${encodeURIComponent(path)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(await readError(res, url));
    return URL.createObjectURL(await res.blob());
  },
  sites: () =>
    get<{ base: string | null; sites: SiteInfo[] }>("/api/sites"),
  openWorkspace: () => post<{ opened: string }>("/api/workspace/open", {}),
  configureConversation: (
    id: string,
    config: { brief?: string | null; toolAllow?: string[] | null },
  ) => post<Conversation>("/api/conversations/configure", { id, ...config }),
  newConversation: (title?: string) =>
    post<Conversation>("/api/conversations/new", title ? { title } : {}),
  mentions: (q: string, kind?: string) =>
    get<{
      mentions: { kind: string; id: string; label: string; hint?: string }[];
      commands: { name: string; args?: string; description: string }[];
    }>(
      `/api/mentions?q=${encodeURIComponent(q)}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`,
    ),
  stopConversation: (sessionId: string) =>
    post<{ stopping: boolean }>("/api/conversations/stop", { sessionId }),
  /** Retry, edit and fork: rewind to an owner message and run from there. */
  rewind: (
    sessionId: string,
    index: number,
    opts: { text?: string; forkTitle?: string } = {},
  ) =>
    post<{ reply: string; conversationId: string }>("/api/conversations/rewind", {
      sessionId,
      index,
      ...opts,
    }),
  renameConversation: (id: string, title: string) =>
    post<Conversation>("/api/conversations/rename", { id, title }),
  archiveConversation: (id: string) =>
    post<Conversation>("/api/conversations/archive", { id, archived: true }),
  deleteConversation: (id: string) =>
    post<{ id: string; removed: boolean }>("/api/conversations/delete", { id }),
  memory: (limit = 200) =>
    get<{ facts: FactRow[]; tags: string[] }>(`/api/memory?limit=${limit}`),
  pinMemory: (key: string, pinned: boolean) =>
    post<FactRow>("/api/memory/pin", { key, pinned }),
  saveMemory: (
    key: string,
    value: string,
    kind: "fact" | "preference" = "fact",
    tags?: string[],
  ) =>
    post<FactRow>("/api/memory", {
      key,
      value,
      kind,
      ...(tags?.length ? { tags } : {}),
    }),
  deleteMemory: (key: string) =>
    post<{ key: string; removed: boolean }>("/api/memory/delete", { key }),
  approve: (id: number) =>
    post<{ ok: boolean; message: string; reply?: string }>("/api/approve", {
      id,
    }),
  deny: (id: number) =>
    post<{ ok: boolean; message: string; reply?: string }>("/api/deny", { id }),
  setKill: (halted: boolean) => post<Status>("/api/kill", { halted }),
  message: (text: string, sessionId?: string, attachments?: Attachment[]) =>
    post<{ reply: string }>("/api/message", {
      text,
      ...(sessionId ? { sessionId } : {}),
      ...(attachments?.length ? { attachments } : {}),
    }),
  snapshot: (message?: string) =>
    post<{ sha: string | null }>("/api/snapshot", message ? { message } : {}),
  clear: (sessionId?: string) =>
    post<{ cleared: string }>(
      "/api/clear",
      sessionId ? { sessionId } : {},
    ),
};
