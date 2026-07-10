/**
 * HTTP client for the multi-modal kos host. The CLI attaches here instead of
 * booting a second Kernel against the same workspace SQLite.
 */

export interface KosClientOptions {
  baseUrl: string;
  token?: string;
}

export class KosClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(options: KosClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    if (options.token) this.token = options.token;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${path}: ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${path}: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  health(): Promise<{
    ok: boolean;
    pid: number;
    discord: boolean;
    cron: boolean;
    workspace: string;
  }> {
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
    pid?: number;
    workspace?: string;
  }> {
    return this.get("/api/status");
  }

  message(
    text: string,
    opts: { sessionId?: string; userId?: string } = {},
  ): Promise<{ reply: string; halted: boolean; sessionId?: string }> {
    return this.post("/api/message", {
      text,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
    });
  }

  clear(sessionId?: string): Promise<{ cleared: string }> {
    return this.post("/api/clear", sessionId ? { sessionId } : {});
  }

  approvals(): Promise<
    Array<{ id: number; tool: string; args: string; reason: string | null }>
  > {
    return this.get("/api/approvals");
  }

  approve(id: number): Promise<{ ok: boolean; message: string }> {
    return this.post("/api/approve", { id });
  }

  deny(id: number): Promise<{ ok: boolean; message: string }> {
    return this.post("/api/deny", { id });
  }

  setKill(halted: boolean): Promise<{ halted: boolean }> {
    return this.post("/api/kill", { halted });
  }

  crons(): Promise<
    Array<{
      id: number;
      name: string;
      schedule: string;
      type: string;
      enabled: boolean;
    }>
  > {
    return this.get("/api/crons");
  }

  memory(): Promise<{ facts: Array<{ kind: string; key: string; value: string }> }> {
    return this.get("/api/memory");
  }

  pages(): Promise<
    Array<{ id: string; projectSlug: string; title: string }>
  > {
    return this.get("/api/pages");
  }

  snapshot(message?: string): Promise<{ sha: string | null }> {
    return this.post("/api/snapshot", message ? { message } : {});
  }
}

/** Probe whether a host is up at baseUrl. */
export async function probeDaemon(
  baseUrl: string,
  token?: string,
): Promise<boolean> {
  try {
    const client = new KosClient({
      baseUrl,
      ...(token ? { token } : {}),
    });
    const h = await client.health();
    return h.ok === true;
  } catch {
    return false;
  }
}
