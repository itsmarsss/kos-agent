/** Typed client for the KOS dashboard API (see harness server.ts). */

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
  slug: string;
  name: string;
  type: string;
  status: string;
  lastTouchedAt: number;
}

export interface CronJob {
  id: number;
  name: string;
  schedule: string;
  type: string;
  enabled: boolean;
}

export interface RunRecord {
  id: number;
  kind: string;
  status: string;
  error: string | null;
  startedAt: number;
}

export interface AuditRecord {
  id: number;
  tool: string;
  isError: boolean;
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
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  status: () => get<Status>("/api/status"),
  approvals: () => get<PendingAction[]>("/api/approvals"),
  projects: () => get<Project[]>("/api/projects"),
  crons: () => get<CronJob[]>("/api/crons"),
  failed: () => get<RunRecord[]>("/api/failed"),
  activity: () => get<{ tools: AuditRecord[]; runs: RunRecord[] }>("/api/activity"),
  pages: (project?: string) =>
    get<PageSummary[]>(
      project ? `/api/pages?project=${encodeURIComponent(project)}` : "/api/pages",
    ),
  page: (id: string) => get<PagePayload>(`/api/pages/${encodeURIComponent(id)}`),
  memory: () => get<{ facts: unknown[] }>("/api/memory"),
  approve: (id: number) => post("/api/approve", { id }),
  deny: (id: number) => post("/api/deny", { id }),
  setKill: (halted: boolean) => post<Status>("/api/kill", { halted }),
  message: (text: string) => post<{ reply: string }>("/api/message", { text }),
};
