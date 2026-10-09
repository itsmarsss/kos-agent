/** Typed client for the KOS dashboard API. */

export interface Status {
  halted: boolean;
  queueDepth: number;
  crons: number;
  pendingApprovals: number;
  projects?: number;
  pages?: number;
  discord?: boolean;
  /** Whether an outside service can start a job through /api/hooks. */
  hooks?: boolean;
  pid?: number;
  workspace?: string;
  orchestratorId?: string;
  /** Jobs failing right now, so the header can stop claiming all is well. */
  unhealthy?: number;
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
  /** anthropic, openai, or custom (the owner's own endpoint). */
  provider?: string;
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

/** A skill as the owner sees it in Settings. */
export interface SkillInfo {
  name: string;
  description: string;
  kind: "script" | "prompt";
  file: string;
  projects?: string[];
  enabled: boolean;
  /** The repository it was installed from, when it was. */
  origin?: string | null;
}

/** A skill offered by the catalogue: a folder in a repository, ready to install. */
export interface CatalogSkill {
  name: string;
  description: string;
  /** The GitHub tree URL the installer takes. */
  source: string;
  repo: string;
  installed: boolean;
}

/** A repository GitHub returned for a search, as something to browse. */
export interface RepoHit {
  repo: string;
  description: string;
  stars: number;
  url: string;
}

export interface CatalogSkills {
  sources: { repo: string; path: string; label: string; blurb: string }[];
  source: { repo: string; path: string };
  skills: CatalogSkill[];
}

export interface CatalogEnvVar {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
}

/** A server as the MCP registry lists it, trimmed to what adding it needs. */
export interface CatalogMcpListing {
  name: string;
  title: string;
  description: string;
  version: string;
  repository?: string;
  packages: { registry: string; identifier: string; version?: string; runtime?: string; env: CatalogEnvVar[] }[];
  remotes: { type: string; url: string; headers: CatalogEnvVar[] }[];
  suggestedName: string;
  installed: boolean;
}

export interface CatalogMcp {
  picks: { name: string; blurb: string; needs: "node" | "uv" | "docker"; command: string; installed: boolean }[];
  results: CatalogMcpListing[];
}

/** A server in mcp.json as the owner sees it in Settings, with whether it is up. */
export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  /** The command line, or the URL. */
  command: string;
  enabled: boolean;
  risk: "safe" | "risky";
  /** Floors the owner set per tool, by name or glob. */
  floors: Record<string, "safe" | "risky">;
  projects: string[];
  /** Set once the server was asked to come up. */
  connected?: boolean;
  tools?: string[];
  error?: string;
}

/** A module in the workspace as the owner sees it in Settings. */
export interface ModuleInfo {
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
  /** Set once the server was asked to come up. */
  connected?: boolean;
  tools?: string[];
  error?: string;
  /** The repository it was installed from, when it was. */
  origin?: string | null;
  /** Absent for a server; present for a project template. */
  blueprint?: {
    type: string;
    instancing: "single" | "multi";
    schema: number;
    pages: number;
    jobs: number;
    instances: { slug: string; name: string; status: string }[];
  };
}

/** Something the dream job left for the owner to decide. */
/** One claim a review item is about: what it says, and how much it is leaned on. */
export interface ReviewClaim {
  /** As the item lists it: global/city. */
  qualified: string;
  scope: string;
  key: string;
  /** Absent when the claim is gone already. */
  value?: string;
  kind?: string;
  trust?: string;
  useCount?: number;
  lastUsedAt?: number | null;
  createdAt?: number;
}

export interface ReviewItem {
  id: number;
  kind: "contradiction" | "promotion" | "other";
  keys: string[];
  note: string;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
  /** The claims looked up, in the order of `keys`. */
  claims?: ReviewClaim[];
}

/** Another program that shares memory, within a grant. */
export interface CallerInfo {
  id: number;
  name: string;
  readTags: string[];
  writeGlobal: boolean;
  createdAt: number;
  lastSeenAt: number | null;
}

/** A decision the owner made and kept. */
export interface PermissionRule {
  id: number;
  tool: string;
  scope: string | null;
  project: string | null;
  createdAt: number;
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
  /** The thread this job's runs happen in, once it has run at all. */
  conversationId?: string;
  /** A run is happening right now. */
  running?: boolean;
  /** When the last run touched the thread. */
  lastRunAt?: number;
  /** When it fires next, while it is on and the scheduler holds it. */
  nextRunAt?: number;
  /** Which model class answers a self_prompt. */
  task?: "reasoning" | "cheap";
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
  /** The project this conversation belongs to, or null at the root. */
  projectSlug: string | null;
  /** The orchestrator is a conversation, but not one of the owner's chats. */
  /** What sort of thread this is, for grouping in the list. */
  kind?: "orchestrator" | "project" | "surface" | "schedule" | "chat";
  /** What the thread is doing, so the list can say rather than look idle. */
  activity?: "working" | "needs-you" | "error" | "idle";
  /** Why the last turn failed, while the thread is in that state. */
  lastError?: string;
  /** When the owner last looked at it, on any surface. */
  readAt?: number | null;
  /** Newer activity than the owner has seen. */
  unread?: boolean;
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

export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Set when KOS does not know this model's window and you do. */
  contextWindow?: number;
}

export interface ModelDaySpend {
  provider: string;
  model: string;
  day: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** Undefined when the model has no rate set. */
  cost?: number;
}

export interface ModelSpend {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** Absent when no rate has been set for this model. */
  cost?: number;
}

export interface ContextUse {
  conversationId: string;
  /** What KOS itself is keeping, which is knowable for every model. */
  history: ContextUseDetail;
  /** What the most recent turn was sent, as the provider counted it. */
  last?: { inputTokens: number; provider: string; model: string; at: number };
  total: { inputTokens: number; outputTokens: number; calls: number };
  /** Absent when the model's window is not known. */
  window?: number;
  /** What the last turn was given from memory. Absent until a turn has run. */
  recalled?: TurnRecall;
}

export interface TurnRecall {
  at: number;
  projectSlug: string | null;
  facts: { id: number; key: string; value: string; scope: string; pinned: boolean; trust: string }[];
  events: { id: number; role: string; text: string; ts: number }[];
}

export interface ContextUseDetail {
  /** Characters of history retained right now. */
  historyChars: number;
  /** Budget it is trimmed to. */
  maxChars: number;
  exchanges: number;
  maxExchanges: number;
}

export interface PendingMessage {
  id: number;
  text: string;
  attachments: { name: string }[];
}

/** How KOS behaves when nobody is telling it what to do. */
export interface Behaviour {
  /** "api" bills the provider; "sdk" spends a Claude Code subscription. */
  engine: "api" | "sdk";
  autoFix: boolean;
  maxSteps: number;
  fixSteps: number;
  selfPromptsPerHour: number;
  agentMinutes: number;
  agentTurns: number;
  stallMinutes: number;
  /** Minutes a turn holds, suspended, waiting for you to decide. */
  approvalMinutes: number;
  /** Minutes between unprompted look-arounds. Zero is off. */
  heartbeatMinutes: number;
  /** A cheap model reads new conversation and proposes memory claims, in the background. */
  memoryExtraction: boolean;
  /** How much new conversation, in characters, before it reads. */
  extractEveryChars: number;
}

export interface FailingJob {
  key: string;
  label: string;
  /** Consecutive failures, so "once" reads differently from "since Tuesday". */
  streak: number;
  error: string | null;
  since: number;
  lastAt: number;
  /** The chat where KOS is, or was, looking into this. */
  fixing?: { conversationId: string; activity: NonNullable<Conversation["activity"]> };
}

export interface HealthReport {
  ok: boolean;
  failing: FailingJob[];
  recent: { total: number; errors: number; rate: number };
}

/** Tool calls in one hour, for the shape of the day. */
export interface HourCount {
  /** Start of the hour, epoch ms. */
  hour: number;
  calls: number;
  errors: number;
}

/** Tokens on one day, local time. */
export interface DayTotal {
  day: string;
  inputTokens: number;
  outputTokens: number;
}

/** A project as a node on the map: what hangs off it and what it is doing. */
export interface ProjectNode {
  slug: string;
  threads: number;
  working: number;
  needsYou: number;
  jobs: number;
}

/** A scheduled run due soon. */
export interface UpcomingRun {
  id: number;
  name: string;
  at: number;
}

export interface HomeData {
  layout: import("@kos/shared").HomeLayout;
  approvals: PendingAction[];
  agents: BuildRecord[];
  /** The last runs, newest first. */
  runs: RunRecord[];
  health: HealthReport;
  activity: AuditRecord[];
  /** Calls by the hour over the last day; quiet hours are left out. */
  pulse: HourCount[];
  projects: Project[];
  map: ProjectNode[];
  chats: Conversation[];
  crons: CronJob[];
  /** Runs due in the next day, soonest first. */
  upcoming: UpcomingRun[];
  spend: { models: ModelSpend[]; byDay: DayTotal[] };
  memory: HomeMemory;
  modules: { modules: ModuleInfo[]; builtins: BuiltinInfo[] };
}

/** Everything waiting on the owner. */
export interface InboxData {
  approvals: PendingAction[];
  decisions: ReviewItem[];
  failures: FailingJob[];
  suggestions: Suggestion[];
}

/** Something KOS suggested making reusable, waiting on the owner. */
export interface Suggestion {
  id: number;
  kind: "skill" | "blueprint" | "other";
  title: string;
  detail: string;
  action: string | null;
  createdAt: number;
}

/** Memory at a glance, for the home page. */
export interface HomeMemory {
  claims: number;
  unread: number;
  extraction: boolean;
  decisions: number;
  jobs: { id: number; name: string; enabled: boolean; lastRunAt: number | null }[];
}

export interface BuiltinInfo {
  name: string;
  description: string;
  enabled: boolean;
}

export interface BuildRecord {
  id: number;
  dir: string;
  task: string;
  conversationId?: string;
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  latest: string;
  events: {
    at: number;
    kind: string;
    text: string;
    tool?: string;
    input?: Record<string, unknown>;
    output?: string;
    isError?: boolean;
  }[];
  phase?: {
    phase: "thinking" | "writing" | "calling" | "idle";
    partial?: string;
    tool?: string;
  };
  phaseSince?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    turns: number;
    contextTokens: number;
    model?: string;
  };
  files: string[];
  askedFor: number;
  /** Milliseconds of silence, when a working build has gone quiet. */
  quietFor?: number;
}

export interface Retention {
  maxChars: number;
  maxToolResultChars: number;
  maxExchanges: number;
  /** Whether old exchanges fall off the front at all. */
  autoTrim: boolean;
}

export interface SettingsPayload {
  workspace: string;
  profile: { name: string; timezone: string; ownerId: string };
  retention: Retention;
  retentionDefaults: Retention;
  /** Model used by build sub-agents; null means the CLI default. */
  buildModel: string | null;
  halted: boolean;
  envPath: string | null;
  /** False when there is nowhere safe to write keys. */
  envWritable: boolean;
  secrets: Record<
    string,
    {
      label: string;
      hint: string;
      masked: string | null;
      /** Set when the value lives under an older name the host still accepts. */
      storedAs?: string;
    }
  >;
  settings: Record<
    string,
    { label: string; hint: string; value: string; group: "network" | "access" }
  >;
  sitesUrl: string | null;
}

export interface ProjectDetail {
  project: Project;
  tables: { name: string; rows: number; columns: number }[];
  pages: PageSummary[];
  crons: CronJob[];
  sites: SiteInfo[];
  sitesBase: string | null;
  migrations: {
    id: number;
    version: number;
    op: string;
    appliedAt?: number;
  }[];
  /** Recent tool calls that mention this project, newest first. */
  activity: AuditRecord[];
  folder: string;
  /** Threads working under the project; its own orchestrator is not one. */
  agents: Conversation[];
  /** The top of the project's folder. */
  files: DirEntry[];
}

export interface SiteInfo {
  name: string;
  /** Project it belongs to. */
  project: string;
  /** Workspace-relative folder, for the file browser. */
  path: string;
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
  /** global, project:<slug>, or caller:<name>. */
  scope?: string;
  trust?: string;
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
      /** Providers a task may be routed to right now. */
      providers?: string[];
      /** The owner's own OpenAI-compatible endpoint, when set. */
      custom?: { baseUrl: string } | null;
      /** The owner's classifier endpoint, when set. */
      classifier?: { url: string } | null;
    }>("/api/settings/models"),
  saveModelSettings: (settings: ModelSettings) =>
    post<{ saved: ModelSettings }>("/api/settings/models", settings),
  saveClassifierEndpoint: (url: string) =>
    post<{ classifier: { url: string } | null }>("/api/settings/models/classifier", { url }),
  saveCustomEndpoint: (baseUrl: string) =>
    post<{ custom: { baseUrl: string } | null; providers: string[] }>("/api/settings/models/custom", { baseUrl }),
  availableModels: () => get<{ models: string[] }>("/api/models"),
  projects: () => get<Project[]>("/api/projects"),
  setProjectStatus: (slug: string, status: string) =>
    post<Project>("/api/projects/status", { slug, status }),
  skills: () => get<{ skills: SkillInfo[]; invalid: { name: string; reason: string }[] }>("/api/skills"),
  /** A skill from a git URL or a folder: KOS's own shape, or a Claude Code SKILL.md. Off until switched on. */
  installSkill: (source: string, name?: string) =>
    post<{ installed: string; dir: string; kind: "script" | "prompt"; origin: string | null }>("/api/skills/install", {
      source,
      ...(name ? { name } : {}),
    }),
  updateSkill: (name: string) => post<{ updated: string; origin: string | null }>("/api/skills/update", { name }),
  removeSkill: (name: string) => post<{ removed: string }>("/api/skills/remove", { name }),
  mcpServers: () => get<{ servers: McpServerInfo[] }>("/api/mcp"),
  /** Skills in a repository folder, Anthropic's unless a source is given. */
  catalogSkills: (source?: string) =>
    get<CatalogSkills>(`/api/catalog/skills${source ? `?source=${encodeURIComponent(source)}` : ""}`),
  /** Repositories on GitHub that look like they hold skills. */
  catalogSkillSearch: (q: string) => get<{ repos: RepoHit[] }>(`/api/catalog/skills/search?q=${encodeURIComponent(q)}`),
  /** The reference servers, and the registry's answer to a search. */
  catalogMcp: (q: string) => get<CatalogMcp>(`/api/catalog/mcp${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  addMcpPick: (name: string) => post<{ added: string[] }>("/api/mcp/pick", { name }),
  addMcpFromCatalog: (input: { listing: CatalogMcpListing; name?: string; choice: { package?: number; remote?: number }; values: Record<string, string>; risk?: "safe" | "risky" }) =>
    post<{ added: string[] }>("/api/mcp/catalog", input),
  /** One server by name, or a pasted config in KOS's or Claude Code's shape. */
  addMcpServer: (input: { name?: string; server?: Record<string, unknown>; json?: string }) =>
    post<{ added: string[]; status: Record<string, { connected: boolean; tools: string[]; error?: string }> }>("/api/mcp/add", input),
  removeMcpServer: (name: string) => post<{ removed: string }>("/api/mcp/remove", { name }),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    post<{ name: string; enabled: boolean; connected?: boolean; tools?: string[]; error?: string }>("/api/mcp/enable", { name, enabled }),
  setSkillEnabled: (name: string, enabled: boolean) =>
    post<{ name: string; enabled: boolean }>("/api/skills/enable", { name, enabled }),
  modules: () => get<{ modules: ModuleInfo[]; invalid: { name: string; reason: string }[]; builtins?: BuiltinInfo[] }>("/api/modules"),
  createProject: (name: string, type = "project") =>
    post<{ slug: string; name: string; conversationId: string }>("/api/projects/create", { name, type }),
  installModule: (source: string, name?: string) =>
    post<{ installed: string; dir: string; origin: string | null }>("/api/modules/install", { source, ...(name ? { name } : {}) }),
  updateModule: (name: string) => post<{ updated: string }>("/api/modules/update", { name }),
  removeModule: (name: string) => post<{ removed: string }>("/api/modules/remove", { name }),
  instantiateModule: (module: string, name: string) =>
    post<{ project: Project }>("/api/modules/instantiate", { module, name }),
  setModuleEnabled: (name: string, enabled: boolean) =>
    post<{ name: string; enabled: boolean; connected?: boolean; tools?: string[]; error?: string }>("/api/modules/enable", { name, enabled }),
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
  runCron: (id: number) =>
    post<{ ok: boolean; error?: string }>("/api/crons/run", { id }),
  health: () => get<HealthReport>("/api/health/report"),
  fix: (input: { label: string; error: string; what?: string; ref?: string }) =>
    post<{ conversationId: string; title: string; prompt: string }>(
      "/api/fix",
      input,
    ),
  behaviour: () =>
    get<{
      behaviour: Behaviour;
      defaults: Behaviour;
      limits: Record<string, [number, number]>;
    }>("/api/settings/behaviour"),
  saveBehaviour: (behaviour: Behaviour) =>
    post<{ behaviour: Behaviour }>("/api/settings/behaviour", { behaviour }),
  dismissFailure: (key: string) =>
    post<{ dismissed: string }>("/api/health/dismiss", { key }),
  deleteCron: (id: number) =>
    post<{ id: number; removed: boolean }>("/api/crons/delete", { id }),
  failed: (limit = 100) => get<RunRecord[]>(`/api/failed?limit=${limit}`),
  runs: (limit = 100, failedOnly = false) =>
    get<RunRecord[]>(
      `/api/runs?limit=${limit}${failedOnly ? "&failed=1" : ""}`,
    ),
  activity: (limit = 100) =>
    get<{ tools: AuditRecord[] }>(`/api/activity?limit=${limit}`),
  /** One call with its result, which the list leaves out. */
  call: (id: number) => get<AuditRecord>(`/api/activity/call?id=${id}`),
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
  /**
   * A quick question on the side (/btw). Answered with the given chat's
   * history as context and streamed under aside:<contextId>; nothing is
   * recorded into that chat. `prior` carries this side thread's earlier
   * exchanges so a follow-up keeps its context.
   */
  aside: (text: string, contextId?: string, prior?: { role: "user" | "assistant"; text: string }[]) =>
    post<{ reply: string }>("/api/aside", {
      text,
      ...(contextId ? { contextId } : {}),
      ...(prior?.length ? { prior } : {}),
    }),
  orchestrator: (text: string, attachments?: Attachment[]) =>
    post<{ reply: string; conversationId: string }>("/api/orchestrator", {
      text,
      ...(attachments?.length ? { attachments } : {}),
    }),
  conversation: (id: string) =>
    get<{
      id: string;
      messages: ChatTurn[];
      events: ChatEvent[];
      /** Sent while a turn was running, waiting its turn. */
      pending: PendingMessage[];
    }>(
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
  spend: (days = 30) =>
    get<{
      days: number;
      models: ModelSpend[];
      byDay: { day: string; inputTokens: number; outputTokens: number }[];
      byModelDay: ModelDaySpend[];
      rates: Record<string, ModelRate>;
    }>(`/api/spend?days=${days}`),
  saveRates: (rates: Record<string, ModelRate>) =>
    post<{ rates: Record<string, ModelRate> }>("/api/spend/rates", { rates }),
  context: (conversationId: string) =>
    get<ContextUse>(`/api/context?conversationId=${encodeURIComponent(conversationId)}`),
  editPending: (id: number, text: string, conversationId: string) =>
    post<{ pending: PendingMessage[] }>("/api/pending/edit", {
      id,
      text,
      conversationId,
    }),
  deletePending: (id: number, conversationId: string) =>
    post<{ pending: PendingMessage[] }>("/api/pending/delete", {
      id,
      conversationId,
    }),
  forkPending: (id: number) =>
    post<{ conversationId: string }>("/api/pending/fork", { id }),
  home: () => get<HomeData>("/api/home"),
  inbox: () => get<InboxData>("/api/inbox"),
  resolveImprovement: (id: number, action: "accept" | "dismiss") =>
    post<{ accepted?: number; dismissed?: number; conversationId?: string }>("/api/improvements/resolve", { id, action }),
  saveHome: (layout: import("@kos/shared").HomeLayout) =>
    post<{ layout: import("@kos/shared").HomeLayout }>("/api/home", { layout }),
  agents: () => get<{ builds: BuildRecord[] }>("/api/agents"),
  agent: (id: number) =>
    get<{ build: BuildRecord; approvals: PendingAction[] }>(`/api/agents/${id}`),
  startAgent: (dir: string, task: string) =>
    post<{ started: boolean; dir: string }>("/api/agents/start", { dir, task }),
  wakeAgent: (id: number, text: string) =>
    post<{ woke: boolean; dir: string; resumed: boolean }>("/api/agents/wake", {
      id,
      text,
    }),
  forgetAgent: (id: number) =>
    post<{ builds: BuildRecord[] }>("/api/agents/forget", { id }),
  stopAgent: (id: number) =>
    post<{ stopped: boolean; builds: BuildRecord[] }>("/api/agents/stop", { id }),
  sendToAgent: (id: number, text: string) =>
    post<{ sent: boolean; builds: BuildRecord[] }>("/api/agents/send", { id, text }),
  interruptAgent: (id: number) =>
    post<{ interrupted: boolean; builds: BuildRecord[] }>("/api/agents/interrupt", {
      id,
    }),
  settings: () => get<SettingsPayload>("/api/settings"),
  saveProfile: (name: string, timezone: string) =>
    post<{ profile: { name: string; timezone: string } }>(
      "/api/settings/profile",
      { name, timezone },
    ),
  saveBuildModel: (buildModel: string) =>
    post<{ buildModel: string | null }>("/api/settings/builds", { buildModel }),
  saveRetention: (retention: Partial<Retention>) =>
    post<{ retention: Retention }>("/api/settings/retention", retention),
  saveSettings: (values: Record<string, string>) =>
    post<{ written: string[]; cleared: string[] }>("/api/settings", { values }),
  projectDetail: (slug: string) =>
    get<ProjectDetail>(`/api/projects/${encodeURIComponent(slug)}/detail`),
  /**
   * Put a file in the project's folder, or a folder inside it. The name is
   * kept to its last segment; the folder must stay inside the project.
   */
  uploadProjectFile: (slug: string, file: Attachment, dir = "") =>
    post<{ path: string; size: number }>(
      `/api/projects/${encodeURIComponent(slug)}/files`,
      { ...file, dir },
    ),
  /**
   * Start an agent under the project. Untitled, its first message names it;
   * a task, when given, is asked at once.
   */
  createProjectAgent: (
    slug: string,
    input: { title?: string; brief?: string; task?: string } = {},
  ) =>
    post<Conversation & { started: boolean }>(
      `/api/projects/${encodeURIComponent(slug)}/agents`,
      input,
    ),
  sites: () =>
    get<{ base: string | null; sites: SiteInfo[] }>("/api/sites"),
  openWorkspace: () => post<{ opened: string }>("/api/workspace/open", {}),
  configureConversation: (
    id: string,
    config: { brief?: string | null; toolAllow?: string[] | null },
  ) => post<Conversation>("/api/conversations/configure", { id, ...config }),
  newConversation: (title?: string, projectSlug?: string) =>
    post<Conversation>("/api/conversations/new", {
      ...(title ? { title } : {}),
      ...(projectSlug ? { projectSlug } : {}),
    }),
  /** A project's own chat, made on first use so it can be opened before it is spoken to. */
  projectChat: (slug: string) => post<Conversation>("/api/projects/chat", { slug }),
  folders: () => get<{ folders: string[] }>("/api/folders"),
  /** Things to point at. With `project`, that project's own come first. */
  mentions: (q: string, kind?: string, limit?: number, project?: string) =>
    get<{
      mentions: { kind: string; id: string; label: string; hint?: string }[];
      commands: { name: string; args?: string; description: string }[];
    }>(
      `/api/mentions?q=${encodeURIComponent(q)}` +
        (kind ? `&kind=${encodeURIComponent(kind)}` : "") +
        (limit ? `&limit=${limit}` : "") +
        (project ? `&project=${encodeURIComponent(project)}` : ""),
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
  archiveConversation: (id: string, archived = true) =>
    post<Conversation>("/api/conversations/archive", { id, archived }),
  deleteConversation: (id: string) =>
    post<{ id: string; removed: boolean }>("/api/conversations/delete", { id }),
  memory: (limit = 200) =>
    get<{ facts: FactRow[]; tags: string[] }>(`/api/memory?limit=${limit}`),
  pinMemory: (key: string, pinned: boolean) =>
    post<FactRow>("/api/memory/pin", { key, pinned }),
  memoryReview: () =>
    get<{ pending: ReviewItem[]; recent: ReviewItem[]; pages: { name: string; path: string; updatedAt: number }[]; edited: string[] }>("/api/memory/review"),
  resolveMemoryReview: (id: number, action: "keep" | "both" | "promote" | "dismiss", key?: string) =>
    post<{ item: ReviewItem; archived: string[]; promoted: string[] }>("/api/memory/review/resolve", { id, action, ...(key ? { key } : {}) }),
  importMemoryPages: (name?: string) =>
    post<{ imported: { name: string; imported: string[]; unchanged: number }[] }>("/api/memory/pages/import", name ? { name } : {}),
  memoryPage: (name: string) => get<{ name: string; markdown: string }>(`/api/memory/page?name=${encodeURIComponent(name)}`),
  memoryLog: (query?: string, limit = 50) =>
    get<{ events: { id: number; ts: number; role: string; text: string; projectSlug: string | null; conversationId: string | null; caller: string; trust: string; shadowed: boolean }[]; query: string }>(
      `/api/memory/log?limit=${limit}${query ? `&query=${encodeURIComponent(query)}` : ""}`,
    ),
  memoryExtractStatus: () => get<{ enabled: boolean; everyChars: number; pending: { count: number; chars: number }; lastEventId: number; running: boolean }>("/api/memory/extract"),
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
  /** Approve; with remember, the same shape stops asking. */
  approve: (id: number, remember = false) =>
    post<{ ok: boolean; message: string; reply?: string }>("/api/approve", {
      id,
      ...(remember ? { remember: true } : {}),
    }),
  callers: () => get<{ callers: CallerInfo[] }>("/api/callers"),
  createCaller: (name: string, readTags: string[], writeGlobal: boolean) =>
    post<{ caller: CallerInfo; token: string }>("/api/callers", { name, readTags, writeGlobal }),
  revokeCaller: (id: number) => post<{ id: number; revoked: boolean }>("/api/callers/revoke", { id }),
  permissions: () => get<{ rules: PermissionRule[] }>("/api/permissions"),
  revokePermission: (id: number) => post<{ id: number; revoked: boolean }>("/api/permissions/revoke", { id }),
  deny: (id: number) =>
    post<{ ok: boolean; message: string; reply?: string }>("/api/deny", { id }),
  setKill: (halted: boolean) => post<Status>("/api/kill", { halted }),
  message: (text: string, sessionId?: string, attachments?: Attachment[]) =>
    post<{
      reply: string;
      isCommand?: boolean;
      switchedTo?: string;
      opens?: "tools";
    }>("/api/message", {
      text,
      ...(sessionId ? { sessionId } : {}),
      ...(attachments?.length ? { attachments } : {}),
    }),
  snapshot: (message?: string) =>
    post<{ sha: string | null; excluded: string[] }>(
      "/api/snapshot",
      message ? { message } : {},
    ),
  clear: (sessionId?: string) =>
    post<{ cleared: string }>(
      "/api/clear",
      sessionId ? { sessionId } : {},
    ),
};
