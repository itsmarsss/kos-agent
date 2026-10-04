/**
 * A typed client for a running KOS host.
 *
 * KOS is meant to be one agent that other things talk to: the CLI, the
 * dashboard, and any project of the owner's that needs an agent and would
 * rather borrow this one than carry its own. This is the way in. It is
 * HTTP against the host's API with the dashboard token, nothing more, so
 * it has no dependencies and runs wherever fetch does.
 */

export interface KosClientOptions {
  /** Where the host listens, for example http://127.0.0.1:4317. */
  baseUrl: string;
  /** The dashboard token, when the host was started with one. */
  token?: string;
}

export interface Fact {
  id: number;
  key: string;
  value: string;
  kind: "fact" | "preference";
  source: string | null;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Reply {
  reply: string;
  halted: boolean;
  sessionId?: string;
}

export class KosClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(options: KosClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    if (options.token) this.token = options.token;
  }

  private headers(json = false, bearer = this.token): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (bearer) h.authorization = `Bearer ${bearer}`;
    return h;
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // Host

  health(): Promise<{ ok: boolean; pid: number; discord: boolean; cron: boolean; workspace: string }> {
    return this.get("/api/health");
  }

  status(): Promise<{
    halted: boolean;
    queueDepth: number;
    crons: number;
    pendingApprovals: number;
    projects: number;
    pages: number;
    discord?: boolean;
    hooks?: boolean;
    pid?: number;
    workspace?: string;
  }> {
    return this.get("/api/status");
  }

  setKill(halted: boolean): Promise<{ halted: boolean }> {
    return this.post("/api/kill", { halted });
  }

  snapshot(message?: string): Promise<{ sha: string | null }> {
    return this.post("/api/snapshot", message ? { message } : {});
  }

  // Talking to it

  /** One turn in a conversation. No sessionId means the owner's primary one. */
  message(text: string, opts: { sessionId?: string; userId?: string } = {}): Promise<Reply> {
    return this.post("/api/message", {
      text,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
    });
  }

  /**
   * One turn in a project's own conversation, where the project's tables,
   * skills and scoped agents are in reach. This is how another program
   * borrows KOS for its project: name the project, say the thing.
   */
  ask(project: string, text: string): Promise<Reply> {
    return this.message(text, { sessionId: `project:${project}` });
  }

  /** Make sure a project's conversation exists, and get its id. */
  project(slug: string): Promise<{ id: string; title: string }> {
    return this.post("/api/projects/chat", { slug });
  }

  clear(sessionId?: string): Promise<{ cleared: string }> {
    return this.post("/api/clear", sessionId ? { sessionId } : {});
  }

  // Memory, shared by everything that talks to KOS

  memory(limit?: number): Promise<{ facts: Fact[]; tags: string[] }> {
    return this.get(`/api/memory${limit ? `?limit=${limit}` : ""}`);
  }

  remember(
    key: string,
    value: string,
    opts: { kind?: "fact" | "preference"; tags?: string[]; pinned?: boolean } = {},
  ): Promise<Fact> {
    return this.post("/api/memory", { key, value, ...opts });
  }

  forget(key: string): Promise<{ key: string; removed: boolean }> {
    return this.post("/api/memory/delete", { key });
  }

  pin(key: string, pinned = true): Promise<Fact> {
    return this.post("/api/memory/pin", { key, pinned });
  }

  // Decisions

  approvals(): Promise<Array<{ id: number; tool: string; args: string; reason: string | null }>> {
    return this.get("/api/approvals");
  }

  approve(id: number, opts: { remember?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    return this.post("/api/approve", { id, ...opts });
  }

  deny(id: number): Promise<{ ok: boolean; message: string }> {
    return this.post("/api/deny", { id });
  }

  // What it has

  crons(): Promise<Array<{ id: number; name: string; schedule: string; type: string; enabled: boolean }>> {
    return this.get("/api/crons");
  }

  pages(): Promise<Array<{ id: string; projectSlug: string; title: string }>> {
    return this.get("/api/pages");
  }

  modules(): Promise<{
    modules: Array<{ name: string; description: string; enabled: boolean; connected?: boolean; tools?: string[]; error?: string }>;
    invalid: Array<{ name: string; reason: string }>;
  }> {
    return this.get("/api/modules");
  }

  enableModule(name: string, enabled: boolean): Promise<{ name: string; enabled: boolean; connected?: boolean; tools?: string[]; error?: string }> {
    return this.post("/api/modules/enable", { name, enabled });
  }

  /**
   * Start a scheduled job by name through its inbound hook. The hook has its
   * own secret, not the dashboard token: a caller holding it can start that
   * one job and nothing else. Answers before the run.
   */
  async fireHook(job: string, secret: string): Promise<{ accepted: string }> {
    const path = `/api/hooks/${encodeURIComponent(job)}`;
    const res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: this.headers(false, secret) });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as { accepted: string };
  }
}

/** Whether a host answers at baseUrl. */
export async function probeDaemon(baseUrl: string, token?: string): Promise<boolean> {
  try {
    const client = new KosClient({ baseUrl, ...(token ? { token } : {}) });
    return (await client.health()).ok === true;
  } catch {
    return false;
  }
}
