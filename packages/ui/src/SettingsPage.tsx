import { m } from "motion/react";
import { ease } from "./motion.js";
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import {
  api,
  type Behaviour,
  type ModelRate,
  type SettingsPayload, type ModuleInfo, type SkillInfo, type McpServerInfo, type PermissionRule } from "./api.js";
import { ModelSettings } from "./ModelSettings.js";
import { Select } from "./Select.js";
import { isDensity, isTheme, readDensity, readTheme, setDensity, setTheme, type Density, type Theme } from "./theme.js";
import { SpendPanel } from "./SpendPanel.js";

/**
 * Everything you would otherwise have opened a dotfile to change.
 *
 * Grouped and reachable rather than stacked: a settings page you have to
 * scroll to the bottom of to find out what is on it is one you avoid. The rail
 * says what exists, each section holds one subject, and each saves on its own
 * so nothing is half-applied.
 *
 * Keys are write-only from here. What comes back is whether one is set and its
 * last four characters, which is enough to tell two apart and no use to
 * anyone; the value itself never leaves the machine it is stored on.
 */

/**
 * What the fields show before the server has answered. The same numbers the
 * harness defaults to, so an unread settings page is not also a wrong one.
 */
const BEHAVIOUR_FALLBACK: Behaviour = {
  engine: "api",
  autoFix: false,
  maxSteps: 10,
  fixSteps: 24,
  selfPromptsPerHour: 10,
  agentMinutes: 15,
  agentTurns: 60,
  stallMinutes: 3,
  approvalMinutes: 30,
  heartbeatMinutes: 0,
  memoryExtraction: false,
  extractEveryChars: 6000,
};

/**
 * Also a save key, not only a nav section: two independent saves can live on
 * one tab, and each needs its own busy and saved state.
 */
type SectionId =
  | "engine"
  | "you"
  | "providers"
  | "models"
  | "conversation"
  | "behaviour"
  | "appearance"
  | "network"
  | "spend"
  | "skills"
  | "modules"
  | "mcp"
  | "permissions"
  | "workspace";

/**
 * The rail, grouped by what you came to do. Eleven subjects in one column did
 * not scan; five headings do, and each one names a reason to be here.
 */
const SECTIONS: { id: SectionId; group: string; label: string; blurb: string }[] = [
  { id: "you", group: "Account", label: "You", blurb: "Who KOS thinks it is working for" },
  { id: "providers", group: "Account", label: "Providers", blurb: "API keys and channel credentials" },
  { id: "models", group: "Account", label: "Models", blurb: "Which model answers, which builds, which is cheap" },
  { id: "conversation", group: "Conduct", label: "Conversation", blurb: "How much history is kept" },
  { id: "behaviour", group: "Conduct", label: "Behaviour", blurb: "How KOS acts when you are not watching" },
  { id: "appearance", group: "Conduct", label: "Appearance", blurb: "Palette and density, for this browser" },
  { id: "skills", group: "Extensions", label: "Skills", blurb: "What KOS knows how to do, and which are on" },
  { id: "modules", group: "Extensions", label: "Modules", blurb: "Features built as servers, and which are running" },
  { id: "mcp", group: "Extensions", label: "MCP servers", blurb: "Outside tools, by the protocol they speak" },
  { id: "permissions", group: "Access", label: "Permissions", blurb: "Decisions you made at a prompt and kept" },
  { id: "network", group: "Access", label: "Network", blurb: "Ports, binding, and what the agent may reach" },
  { id: "spend", group: "Housekeeping", label: "Spend", blurb: "Tokens used and what they cost" },
  { id: "workspace", group: "Housekeeping", label: "Workspace", blurb: "Where everything lives" },
];

const GROUPS = [...new Set(SECTIONS.map((s) => s.group))];

function isSection(id: string | undefined): id is SectionId {
  return SECTIONS.some((s) => s.id === id);
}

/** One setting: a label, the control, and why you would touch it. */
function Field({
  label,
  hint,
  children,
  badge,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  badge?: ReactNode;
}): ReactElement {
  return (
    <div className="set-field">
      <div className="set-label">
        <span>{label}</span>
        {badge}
      </div>
      {children}
      {hint && <p className="set-hint">{hint}</p>}
    </div>
  );
}

/**
 * A bounded number. Typed or nudged, and never outside its range: these
 * govern spend and runaway loops, so the field itself should not be able to
 * express "loop for a day".
 */
function Limit({
  label,
  hint,
  value,
  range,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  range?: [number, number];
  onChange: (value: number) => void;
}): ReactElement {
  const [min, max] = range ?? [1, 1000];
  return (
    <Field label={label} hint={`${hint} Between ${min} and ${max}.`}>
      <input
        className="kos-input set-limit"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) {
            onChange(Math.min(max, Math.max(min, Math.round(next))));
          }
        }}
      />
    </Field>
  );
}

/**
 * A set of hostnames, edited one at a time.
 *
 * Stored as the comma-separated string the environment file wants, because
 * that is what the host reads; shown as what it is.
 */
function HostList({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const hosts = value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  const write = (next: string[]): void => onChange(next.join(", "));

  const add = (): void => {
    // Typed with a scheme or a path, which is the natural thing to paste.
    const cleaned = draft
      .trim()
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
    if (!cleaned || hosts.includes(cleaned)) {
      setDraft("");
      return;
    }
    write([...hosts, cleaned]);
    setDraft("");
  };

  return (
    <div className="hostlist">
      {hosts.length > 0 && (
        <ul className="hostlist-items">
          {hosts.map((h) => (
            <li key={h}>
              <span className="ops-mono">{h}</span>
              <button
                type="button"
                className="icon-btn icon-btn--bare"
                title={`Stop allowing ${h}`}
                onClick={() => write(hosts.filter((x) => x !== h))}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="hostlist-add">
        <input
          className="kos-input"
          value={draft}
          placeholder="rss.nytimes.com"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={!draft.trim()}
          onClick={add}
        >
          Allow
        </button>
      </div>
      {hosts.length === 0 && (
        <span className="hint">
          Nothing is allowed, so http.fetch can reach nothing.
        </span>
      )}
    </div>
  );
}

function Section({
  title,
  blurb,
  children,
  onSave,
  saving,
  saved,
  canSave,
  extra,
}: {
  title: string;
  blurb: string;
  children: ReactNode;
  onSave?: () => void;
  saving?: boolean;
  saved?: string | null;
  /** Withhold Save until something has changed. Undefined means always on. */
  canSave?: boolean;
  /** Another action beside Save, in the same footer as every other tab. */
  extra?: ReactNode;
}): ReactElement {
  return (
    <section className="set-card">
      <header className="set-card-head">
        <h2>{title}</h2>
        <p>{blurb}</p>
      </header>
      <div className="set-card-body">{children}</div>
      {onSave && (
        <footer className="set-card-foot">
          <button
            type="button"
            className="btn btn--primary"
            disabled={saving || canSave === false}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {extra}
          {saved && (
            <span
              className={`set-saved ${saved === "Not saved yet" ? "is-unsaved" : ""}`}
            >
              {saved}
            </span>
          )}
        </footer>
      )}
    </section>
  );
}

/** The zones this machine knows, so a typo cannot break every schedule. */
function timezones(): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  ).supportedValuesOf;
  try {
    return supported?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function SettingsPage({
  section,
  onSection,
}: {
  /** The section the hash names, so a link can land on one. */
  section?: string;
  onSection?: (section: SectionId) => void;
} = {}): ReactElement {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActiveState] = useState<SectionId>(isSection(section) ? section : "you");
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [density, setDensityState] = useState<Density>(readDensity);
  useEffect(() => {
    if (isSection(section)) setActiveState(section);
  }, [section]);
  const setActive = (id: SectionId): void => {
    setActiveState(id);
    onSection?.(id);
  };
  const [how, setHow] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  /** The last values the server confirmed, so an edit can be seen as one. */
  const [savedHow, setSavedHow] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  const [defaults, setDefaults] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  const [limits, setLimits] = useState<Record<string, [number, number]>>({});
  /** ModelSettings owns its draft, so it hands its save up to the footer. */
  const saveModels = useRef<(() => void) | null>(null);
  /** ModelSettings owns its draft, so it reports whether that draft differs. */
  const [modelsDirty, setModelsDirty] = useState(false);
  const [busy, setBusy] = useState<SectionId | null>(null);
  const [skills, setSkills] = useState<{ skills: SkillInfo[]; invalid: { name: string; reason: string }[] }>({
    skills: [],
    invalid: [],
  });
  const loadSkills = useCallback(() => {
    void api
      .skills()
      .then(setSkills)
      .catch(() => setSkills({ skills: [], invalid: [] }));
  }, []);
  useEffect(() => {
    if (active === "skills") loadSkills();
  }, [active, loadSkills]);
  const [modules, setModules] = useState<{ modules: ModuleInfo[]; invalid: { name: string; reason: string }[]; builtins?: { name: string; description: string; enabled: boolean }[] }>({
    modules: [],
    invalid: [],
  });
  const [moduleBusy, setModuleBusy] = useState<string | null>(null);
  const [newInstance, setNewInstance] = useState<Record<string, string>>({});
  const [installSource, setInstallSource] = useState("");
  /** A skill on its way in: where from, and what to call it. */
  const [skillSource, setSkillSource] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  /** The servers in mcp.json, with whether each is up. */
  const [mcp, setMcp] = useState<McpServerInfo[]>([]);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [mcpDraft, setMcpDraft] = useState({ name: "", where: "", risk: "risky" as "risky" | "safe" });
  const [mcpJson, setMcpJson] = useState("");
  const loadMcp = useCallback(() => {
    void api
      .mcpServers()
      .then((r) => setMcp(r.servers))
      .catch(() => setMcp([]));
  }, []);
  useEffect(() => {
    if (active === "mcp") loadMcp();
  }, [active, loadMcp]);
  /** A server from the name and the command line or URL typed for it. */
  const addMcpFromDraft = (): void => {
    const name = mcpDraft.name.trim();
    const where = mcpDraft.where.trim();
    if (!name || !where) return;
    const server: Record<string, unknown> = /^https?:\/\//.test(where)
      ? { url: where }
      : (() => {
          const [command, ...args] = where.split(/\s+/);
          return { command, args };
        })();
    if (mcpDraft.risk === "safe") server["risk"] = "safe";
    setMcpBusy("add");
    void api
      .addMcpServer({ name, server })
      .then(() => {
        setMcpDraft({ name: "", where: "", risk: "risky" });
        loadMcp();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setMcpBusy(null));
  };
  const addMcpFromJson = (): void => {
    const json = mcpJson.trim();
    if (!json) return;
    setMcpBusy("json");
    void api
      .addMcpServer({ json })
      .then(() => {
        setMcpJson("");
        loadMcp();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setMcpBusy(null));
  };
  /** A skill from a git URL or a folder; it arrives off. */
  const installSkillFromDraft = (): void => {
    const source = skillSource.trim();
    if (!source) return;
    setSkillBusy("install");
    void api
      .installSkill(source, skillName.trim() || undefined)
      .then(() => {
        setSkillSource("");
        setSkillName("");
        loadSkills();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSkillBusy(null));
  };
  const loadModules = useCallback(() => {
    void api
      .modules()
      .then(setModules)
      .catch(() => setModules({ modules: [], invalid: [] }));
  }, []);
  useEffect(() => {
    if (active === "modules") loadModules();
  }, [active, loadModules]);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const loadRules = useCallback(() => {
    void api.permissions().then((r) => setRules(r.rules)).catch(() => setRules([]));
  }, []);
  useEffect(() => {
    if (active === "permissions") loadRules();
  }, [active, loadRules]);
  const [saved, setSaved] = useState<Partial<Record<SectionId, string>>>({});

  const [profile, setProfile] = useState({ name: "", timezone: "" });
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [buildModel, setBuildModel] = useState("");
  const [retention, setRetention] = useState({
    maxChars: "",
    maxToolResultChars: "",
    maxExchanges: "",
    // A string like the rest, so one dirty check covers the whole card.
    autoTrim: "on",
  });

  const zones = useRef<string[]>(timezones());

  const load = (): void => {
    void api
      .settings()
      .then((r) => {
        setData(r);
        setProfile({ name: r.profile.name, timezone: r.profile.timezone });
        setBuildModel(r.buildModel ?? "");
        setRetention({
          maxChars: String(r.retention.maxChars),
          maxToolResultChars: String(r.retention.maxToolResultChars),
          maxExchanges: String(r.retention.maxExchanges),
          autoTrim: r.retention.autoTrim === false ? "off" : "on",
        });
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(load, []);
  useEffect(() => {
    void api
      .behaviour()
      .then((r) => {
        setHow(r.behaviour);
        setSavedHow(r.behaviour);
        setDefaults(r.defaults);
        setLimits(r.limits);
      })
      // Unreadable settings stay at the conservative values rather than
      // showing numbers that are not the ones in force.
      .catch(() => undefined);
  }, []);

  const done = (section: SectionId, message: string): void => {
    setSaved((s) => ({ ...s, [section]: message }));
    window.setTimeout(
      () => setSaved((s) => ({ ...s, [section]: undefined })),
      2500,
    );
  };

  const run = (section: SectionId, work: Promise<unknown>, message: string): void => {
    setBusy(section);
    void work
      .then(() => {
        done(section, message);
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(null));
  };

  /**
   * Saved, then adopted from the reply: the server clamps every number, so
   * what comes back is what is in force. Keeping the typed value instead
   * would show 500 in a field that actually holds 100.
   */
  const saveHow = (): void => {
    setBusy("behaviour");
    void api
      .saveBehaviour(how)
      .then((r) => {
        setHow(r.behaviour);
        setSavedHow(r.behaviour);
        done("behaviour", "Saved");
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(null));
  };

  /**
   * The same Save on every tab.
   *
   * Each tab used to wire its own: some always pressable, some not; some
   * saying "Saved", some silent; Models with three of them. One helper, so a
   * tab cannot express a different idea of what saving is.
   */
  const saveBar = (
    section: SectionId,
    dirty: boolean,
    onSave: () => void,
    extra?: ReactNode,
  ): {
    saving: boolean;
    saved: string | null;
    canSave: boolean;
    onSave: () => void;
    extra?: ReactNode;
  } => ({
    saving: busy === section,
    saved: dirty ? "Not saved yet" : (saved[section] ?? null),
    canSave: dirty,
    onSave,
    ...(extra ? { extra } : {}),
  });

  const same = (a: Behaviour, b: Behaviour): boolean =>
    (Object.keys(a) as (keyof Behaviour)[]).every((k) => a[k] === b[k]);
  const changed = !same(how, savedHow);
  const atDefaults = same(how, defaults);

  const saveEnv = (
    section: SectionId,
    draft: Record<string, string>,
    clear: () => void,
  ): void => {
    const values: Record<string, string> = {};
    // Only what was actually typed. An untouched field sent as an empty string
    // would read as "clear this key".
    for (const [k, v] of Object.entries(draft)) if (v !== "") values[k] = v;
    if (Object.keys(values).length === 0) {
      done(section, "Nothing changed");
      return;
    }
    setBusy(section);
    void api
      .saveSettings(values)
      .then(() => {
        clear();
        done(section, "Saved");
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(null));
  };

  if (!data) {
    return (
      <div className="settings-page">
        {error ? (
          <p className="ops-alert ops-alert--err" role="alert">
            {error}
          </p>
        ) : (
          <p className="hint">Loading…</p>
        )}
      </div>
    );
  }

  const networkKeys = Object.entries(data.settings).filter(
    ([, m]) => m.group === "network",
  );
  const accessKeys = Object.entries(data.settings).filter(
    ([, m]) => m.group === "access",
  );

  return (
    <div className="settings-page">
      <nav className="set-rail" aria-label="Settings sections">
        {GROUPS.map((group) => (
          <div key={group} className="set-rail-group">
            <h3 className="set-rail-head">{group}</h3>
            {SECTIONS.filter((s) => s.group === group).map((s) => (
              <button
                key={s.id}
                type="button"
                className={`set-rail-item ${active === s.id ? "is-on" : ""}`}
                onClick={() => setActive(s.id)}
              >
                <span className="set-rail-label">{s.label}</span>
                <span className="set-rail-blurb">{s.blurb}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* Keyed on the tab, so moving between them is a change you can follow
          rather than one frame replaced by another. */}
      <m.div
        className="set-pane"
        key={active}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={ease}
      >
        {error && (
          <p className="ops-alert ops-alert--err" role="alert">
            {error}
          </p>
        )}
        {!data.envWritable && active !== "spend" && active !== "models" && (
          <p className="ops-alert ops-alert--err" role="alert">
            {data.envPath
              ? "The settings file is inside the workspace, so nothing can be saved there: the agent can read anything in the workspace. Move it out and restart."
              : "This host was started without a settings file, so nothing can be saved from here."}
          </p>
        )}

        {active === "you" && (
          <Section
            title="You"
            blurb="Used in the system prompt and to decide what today means for a schedule."
            {...saveBar(
              "you",
              profile.name !== (data.profile?.name ?? "") ||
                profile.timezone !== (data.profile?.timezone ?? ""),
              () =>
                run(
                  "you",
                  api.saveProfile(profile.name, profile.timezone),
                  "Saved",
                ),
            )}
          >
            <Field label="Name" hint="What KOS calls you.">
              <input
                className="kos-input"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field
              label="Timezone"
              hint="Schedules and “today” follow this. Checked against what this machine knows, so a typo cannot quietly move every cron job."
            >
              {zones.current.length > 0 ? (
                <Select
                  className="set-select"
                  label="Timezone"
                  value={profile.timezone}
                  options={zones.current.map((z) => ({ value: z, label: z }))}
                  onChange={(v) => setProfile((p) => ({ ...p, timezone: v }))}
                />
              ) : (
                <input
                  className="kos-input"
                  value={profile.timezone}
                  onChange={(e) =>
                    setProfile((p) => ({ ...p, timezone: e.target.value }))
                  }
                />
              )}
            </Field>
            <Field label="Owner id" hint="Identifies you across channels. Set at first run.">
              <input className="kos-input" value={data.profile.ownerId} readOnly />
            </Field>
          </Section>
        )}

        {active === "providers" && (
          <Section
            title="Providers"
            blurb="Stored outside the workspace, readable only by you. KOS shows the last four characters so you can tell two keys apart; it never sends the value back."
            {...saveBar("providers", Object.keys(keys).length > 0, () =>
              saveEnv("providers", keys, () => setKeys({})),
            )}
          >
            {Object.entries(data.secrets).map(([key, meta]) => (
              <Field
                key={key}
                label={meta.label}
                hint={meta.hint}
                badge={
                  meta.masked ? (
                    <>
                      <span className="set-badge is-set">{meta.masked}</span>
                      {meta.storedAs && (
                        <span className="set-badge" title="An older name this host still accepts">
                          as {meta.storedAs}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="set-badge">not set</span>
                  )
                }
              >
                <div className="set-inline">
                  <input
                    className="kos-input"
                    type="password"
                    autoComplete="new-password"
                    value={keys[key] ?? ""}
                    placeholder={meta.masked ? "unchanged" : "not set"}
                    onChange={(e) =>
                      setKeys((k) => ({ ...k, [key]: e.target.value }))
                    }
                  />
                  {meta.masked && (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy === "providers"}
                      onClick={() =>
                        run("providers", api.saveSettings({ [key]: "" }), "Cleared")
                      }
                    >
                      Clear
                    </button>
                  )}
                </div>
              </Field>
            ))}
          </Section>
        )}

        {active === "models" && (
          /* One card, one Save, like every other tab. This was three cards
             with three Saves, which is the shape the rest of Settings was
             changed away from. */
          <Section
            title="Models"
            blurb="Who answers, which model, and how hard it thinks."
            {...saveBar(
              "models",
              how.engine !== savedHow.engine ||
                modelsDirty ||
                buildModel !== (data.buildModel ?? ""),
              () => {
                // One press writes all three, in the order that matters: the
                // engine decides whether the model choices below apply.
                void run(
                  "models",
                  api
                    .saveBehaviour(how)
                    .then(() => api.saveBuildModel(buildModel)),
                  "Saved",
                );
                saveModels.current?.();
                setSavedHow(how);
              },
            )}
          >
            <div className="set-group">
              <h3>Who does the thinking</h3>
              <p className="hint">
                A turn can go to the model provider, which bills API credits,
                or through the Claude Agent SDK, which is what coding agents
                already use and spends a Claude Code subscription instead.
              </p>
              <Field
                label="Chat engine"
                hint="Either way the only tools are KOS's own, inside the same workspace jail, and risky ones still ask you first. The SDK path needs a signed-in Claude Code on this machine, or an Anthropic key."
              >
                <Select
                  className="set-select"
                  label="Chat engine"
                  value={how.engine}
                  options={[
                    { value: "api", label: "Model provider", hint: "API credits" },
                    {
                      value: "sdk",
                      label: "Claude Agent SDK",
                      hint: "Claude Code subscription",
                    },
                  ]}
                  onChange={(v) =>
                    setHow({ ...how, engine: v === "sdk" ? "sdk" : "api" })
                  }
                />
              </Field>
            </div>

            <div className="set-group">
              <h3>Which model answers</h3>
              <p className="hint">
                Applied on the next turn, no restart. Blank keeps the default.
                Ignored while the Claude Agent SDK is answering, which picks
                its own.
              </p>
              <ModelSettings
                onReady={(fn, dirty) => {
                  saveModels.current = fn;
                  // Only on a change. This is called after every render of
                  // the child, so setting state unconditionally re-rendered
                  // it, which called this again: the page locked solid.
                  setModelsDirty((was) => (was === dirty ? was : dirty));
                }}
              />
            </div>

            <div className="set-group">
              <h3>Build agents</h3>
              <p className="hint">
                Which model does the building when KOS hands work to a coding
                sub-agent.
              </p>
              <Field
                label="Build model"
                hint="A build is many turns and each is a model call, so this is the biggest lever on how long one takes. Sonnet is markedly faster than Opus for scaffolding work."
              >
                <Select
                  className="set-select"
                  label="Build model"
                  value={buildModel}
                  options={[
                    { value: "", label: "Claude Code default" },
                    { value: "sonnet", label: "Sonnet — faster" },
                    { value: "opus", label: "Opus — more capable" },
                    { value: "fable", label: "Fable" },
                  ]}
                  onChange={setBuildModel}
                />
              </Field>
            </div>
          </Section>
        )}

        {active === "behaviour" && (
          /* One card, like every other tab. It was three chained cards and a
             footer of its own, which is why this tab read as a different
             application from the rest of Settings. */
          <Section
            title="Behaviour"
            blurb="How KOS acts when you are not watching. These are one set of settings, saved together."
            {...saveBar(
              "behaviour",
              changed,
              saveHow,
              <button
                type="button"
                className="btn"
                disabled={busy === "behaviour" || atDefaults}
                onClick={() => setHow(defaults)}
              >
                Reset to defaults
              </button>,
            )}
          >
            <div className="set-group">
              <h3>When something fails</h3>
              <p className="hint">
                A job that fails at 3am tells you either way. This decides
                whether KOS also tries to do something about it before you wake
                up.
              </p>
              <Field
                label="Extract memory in the background"
                hint="Off by default. On, a cheap model reads new conversation in batches and proposes claims; what it writes is attributed to it, cites its sources, and shows in Memory. Run it once from the Memory page first and see what it does."
              >
                <label className="set-toggle">
                  <input
                    type="checkbox"
                    checked={how.memoryExtraction}
                    onChange={(e) => setHow({ ...how, memoryExtraction: e.target.checked })}
                  />
                  <span>{how.memoryExtraction ? "On" : "Off"}</span>
                </label>
              </Field>
              <Field
                label="Try to fix failures on its own"
                hint="On the first failure of a job, KOS opens a chat, works out why, and repairs it if it safely can. Later failures of the same job do not start another attempt. Everything it does there still asks you before anything risky."
              >
                <label className="set-toggle">
                  <input
                    type="checkbox"
                    checked={how.autoFix}
                    onChange={(e) => setHow({ ...how, autoFix: e.target.checked })}
                  />
                  <span>{how.autoFix ? "On" : "Off"}</span>
                </label>
              </Field>
            </div>

            <div className="set-group">
              <h3>How hard it tries</h3>
              <p className="hint">
                A step is one round-trip to the model, roughly one thought and
                one tool call. Past the limit a turn stops and says it got stuck
                rather than running on.
              </p>
              <div className="set-grid">
                <Limit
                  label="Steps in a turn"
                  hint={`What an ordinary message gets. Default ${defaults.maxSteps}.`}
                  value={how.maxSteps}
                  range={limits.maxSteps}
                  onChange={(maxSteps) => setHow({ ...how, maxSteps })}
                />
                <Limit
                  label="Steps in a fix attempt"
                  hint={`Diagnosing a failure is mostly reading, so it is worth more than a normal turn. Default ${defaults.fixSteps}.`}
                  value={how.fixSteps}
                  range={limits.fixSteps}
                  onChange={(fixSteps) => setHow({ ...how, fixSteps })}
                />
              </div>
            </div>

            <div className="set-group">
              <h3>Unattended work</h3>
              <p className="hint">
                Limits on what KOS may do while nobody is watching: the guards
                against a loop that runs all night.
              </p>
              <div className="set-grid">
                <Limit
                  label="Check in on its own, every N minutes"
                  hint={`KOS wakes up on its own, looks at what has changed, and messages you only if something needs you. Nothing to say means it says nothing. Zero is off, which is the default: this is the one setting that spends money on a timer rather than because you asked.`}
                  value={how.heartbeatMinutes}
                  range={limits.heartbeatMinutes}
                  onChange={(heartbeatMinutes) =>
                    setHow({ ...how, heartbeatMinutes })
                  }
                />
                <Limit
                  label="Memory extraction: read every N characters of new conversation"
                  hint="A cheap model reads what was said since it last looked and proposes what to remember, each proposal citing the messages it came from. Default 6000, about a page and a half."
                  value={how.extractEveryChars}
                  range={limits.extractEveryChars}
                  onChange={(extractEveryChars) =>
                    setHow({ ...how, extractEveryChars })
                  }
                />
                <Limit
                  label="Self-prompted jobs per hour"
                  hint={`A scheduled job that thinks rather than running fixed actions. Zero stops them entirely. Default ${defaults.selfPromptsPerHour}.`}
                  value={how.selfPromptsPerHour}
                  range={limits.selfPromptsPerHour}
                  onChange={(selfPromptsPerHour) =>
                    setHow({ ...how, selfPromptsPerHour })
                  }
                />
                <Limit
                  label="Minutes to wait for your approval"
                  hint={`A turn suspended on a risky call holds its conversation until you decide. After this it treats the silence as a refusal. Default ${defaults.approvalMinutes}.`}
                  value={how.approvalMinutes}
                  range={limits.approvalMinutes}
                  onChange={(approvalMinutes) =>
                    setHow({ ...how, approvalMinutes })
                  }
                />
                <Limit
                  label="Minutes a coding agent may run"
                  hint={`Stopped at this regardless of what it is doing. Default ${defaults.agentMinutes}.`}
                  value={how.agentMinutes}
                  range={limits.agentMinutes}
                  onChange={(agentMinutes) => setHow({ ...how, agentMinutes })}
                />
                <Limit
                  label="Turns a coding agent may take"
                  hint={`The other end of the same leash, counted in steps rather than time. Default ${defaults.agentTurns}.`}
                  value={how.agentTurns}
                  range={limits.agentTurns}
                  onChange={(agentTurns) => setHow({ ...how, agentTurns })}
                />
                <Limit
                  label="Minutes of silence before an agent looks stuck"
                  hint={`Only changes what the Agents list says about it; nothing is stopped. Default ${defaults.stallMinutes}.`}
                  value={how.stallMinutes}
                  range={limits.stallMinutes}
                  onChange={(stallMinutes) => setHow({ ...how, stallMinutes })}
                />
              </div>
            </div>
          </Section>
        )}

        {active === "appearance" && (
          <Section
            title="Appearance"
            blurb="How this browser shows KOS. Kept here, not in the workspace, so a phone and a desk can differ."
          >
            <Field label="Theme" hint="Dark is the default. System follows the device and changes with it.">
              <Select
                className="set-select"
                label="Theme"
                value={theme}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                  { value: "system", label: "System" },
                ]}
                onChange={(v) => {
                  if (isTheme(v)) {
                    setTheme(v);
                    setThemeState(v);
                  }
                }}
              />
            </Field>
            <Field
              label="Density"
              hint="Compact fits more rows on a laptop. Comfortable makes type and spacing a little larger everywhere, for a phone or a long read."
            >
              <Select
                className="set-select"
                label="Density"
                value={density}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "standard", label: "Standard" },
                  { value: "comfortable", label: "Comfortable" },
                ]}
                onChange={(v) => {
                  if (isDensity(v)) {
                    setDensity(v);
                    setDensityState(v);
                  }
                }}
              />
            </Field>
          </Section>
        )}

        {active === "conversation" && (
          <Section
            title="Conversation"
            blurb="How much of a chat is carried into the next turn. Past these, the oldest exchanges fall off the front; /compact turns them into a summary instead. Set any of them to 0 to stop trimming on that count, at the cost of a history that grows without bound and is re-sent every turn."
            {...saveBar(
              "conversation",
              retention.maxChars !== String(data.retention.maxChars) ||
                retention.maxToolResultChars !==
                  String(data.retention.maxToolResultChars) ||
                retention.maxExchanges !== String(data.retention.maxExchanges) ||
                retention.autoTrim !==
                  (data.retention.autoTrim === false ? "off" : "on"),
              () =>
                run(
                  "conversation",
                  api.saveRetention({
                    maxChars: Number(retention.maxChars),
                    maxToolResultChars: Number(retention.maxToolResultChars),
                    maxExchanges: Number(retention.maxExchanges),
                    autoTrim: retention.autoTrim !== "off",
                  }),
                  "Saved",
                ),
            )}
          >
            <Field
              label="Trim old exchanges"
              hint="When on, the oldest exchanges fall off the front once a chat passes the budgets below, and the chat says so when it happens. Off keeps everything: the whole history is re-sent every turn, so it gets slower and costs more as it grows."
            >
              <label className="set-toggle">
                <input
                  type="checkbox"
                  checked={retention.autoTrim !== "off"}
                  onChange={(e) =>
                    setRetention((r) => ({
                      ...r,
                      autoTrim: e.target.checked ? "on" : "off",
                    }))
                  }
                />
                <span>{retention.autoTrim !== "off" ? "On" : "Off"}</span>
              </label>
            </Field>
            <Field
              label="History budget"
              hint={`Characters of a conversation kept. 0 for no limit. Default ${data.retentionDefaults.maxChars.toLocaleString()}.`}
            >
              <input
                className="kos-input"
                inputMode="numeric"
                value={retention.maxChars}
                onChange={(e) =>
                  setRetention((r) => ({ ...r, maxChars: e.target.value }))
                }
              />
            </Field>
            <Field
              label="Exchanges kept"
              hint={`Hard ceiling regardless of size. 0 for no limit. Default ${data.retentionDefaults.maxExchanges}.`}
            >
              <input
                className="kos-input"
                inputMode="numeric"
                value={retention.maxExchanges}
                onChange={(e) =>
                  setRetention((r) => ({ ...r, maxExchanges: e.target.value }))
                }
              />
            </Field>
            <Field
              label="Tool result cap"
              hint={`A single result longer than this is truncated rather than dropped. 0 for no limit. Default ${data.retentionDefaults.maxToolResultChars.toLocaleString()}.`}
            >
              <input
                className="kos-input"
                inputMode="numeric"
                value={retention.maxToolResultChars}
                onChange={(e) =>
                  setRetention((r) => ({
                    ...r,
                    maxToolResultChars: e.target.value,
                  }))
                }
              />
            </Field>
            <p className="set-note">
              Changes apply to the next trim, not retroactively: shrinking the
              budget does not reach back and delete what a conversation already
              has.
            </p>
          </Section>
        )}

        {active === "network" && (
          <Section
            title="Network"
            blurb="Where KOS listens and what it may reach. Applied the next time the host starts."
            {...saveBar("network", Object.keys(ports).length > 0, () =>
              saveEnv("network", ports, () => setPorts({})),
            )}
          >
            {networkKeys.map(([key, meta]) => (
              <Field
                key={key}
                label={meta.label}
                hint={meta.hint}
                badge={
                  meta.value ? <span className="set-badge is-set">{meta.value}</span> : null
                }
              >
                <input
                  className="kos-input"
                  value={ports[key] ?? ""}
                  placeholder={meta.value || "default"}
                  onChange={(e) => setPorts((p) => ({ ...p, [key]: e.target.value }))}
                />
              </Field>
            ))}
            {accessKeys.map(([key, meta]) => (
              <Field key={key} label={meta.label} hint={meta.hint}>
                {/* A list, edited as a list. It was one text box holding
                    comma-separated hosts, which reads as a sentence and
                    edits like one: no way to see what is on it at a glance,
                    and removing the middle entry meant surgery on a string. */}
                <HostList
                  value={ports[key] ?? meta.value ?? ""}
                  onChange={(next) => setPorts((p) => ({ ...p, [key]: next }))}
                />
              </Field>
            ))}
          </Section>
        )}

        {active === "skills" && (
          <Section title="Skills" blurb="Each one is a folder under skills/ with a skill.json, or a Claude Code skill with a SKILL.md. One KOS wrote is on; one installed is off until you say.">
            {skills.skills.length === 0 && skills.invalid.length === 0 && (
              <p className="hint">No skills yet. Ask KOS to make one with skills.create, install one below, or add a folder under skills/.</p>
            )}
            {/* The same two rungs as a module: a folder, or a repository that
                can be pulled later. A Claude Code skill installs as it is. */}
            <form
              className="set-instance-new set-install"
              onSubmit={(e) => {
                e.preventDefault();
                installSkillFromDraft();
              }}
            >
              <input
                className="kos-input"
                placeholder="Install: a git URL, or a folder path"
                value={skillSource}
                onChange={(e) => setSkillSource(e.target.value)}
              />
              <input
                className="kos-input set-install-name"
                placeholder="Name (optional)"
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
              />
              <button type="submit" className="btn btn--sm" disabled={skillBusy !== null || !skillSource.trim()}>
                {skillBusy === "install" ? "Installing…" : "Install"}
              </button>
            </form>
            {skills.skills.map((sk) => (
              <Field
                key={sk.name}
                label={`${sk.name} (${sk.kind})${sk.projects ? ` · ${sk.projects.join(", ")}` : ""}`}
                hint={sk.description}
              >
                <label className="set-toggle">
                  <input
                    type="checkbox"
                    checked={sk.enabled}
                    disabled={skillBusy === sk.name}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      // Shown at once; the list is re-read after the save so
                      // what is on screen is what the server has.
                      setSkills((cur) => ({ ...cur, skills: cur.skills.map((x) => (x.name === sk.name ? { ...x, enabled } : x)) }));
                      void api.setSkillEnabled(sk.name, enabled).then(loadSkills, loadSkills);
                    }}
                  />
                  <span>{sk.enabled ? "On" : "Off"}</span>
                </label>
                <span className="set-module-actions">
                  {sk.origin && (
                    <button
                      type="button"
                      className="link"
                      disabled={skillBusy === sk.name}
                      onClick={() => {
                        setSkillBusy(sk.name);
                        void api.updateSkill(sk.name).then(loadSkills).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setSkillBusy(null));
                      }}
                    >
                      Update
                    </button>
                  )}
                  <button
                    type="button"
                    className="link is-danger"
                    disabled={skillBusy === sk.name}
                    onClick={() => {
                      setSkillBusy(sk.name);
                      void api.removeSkill(sk.name).then(loadSkills).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setSkillBusy(null));
                    }}
                  >
                    Remove
                  </button>
                  {sk.origin && <span className="hint ops-mono">{sk.origin}</span>}
                </span>
              </Field>
            ))}
            {skills.invalid.length > 0 && (
              <div className="set-group">
                <h3>Could not be read</h3>
                {skills.invalid.map((bad) => (
                  <p key={bad.name} className="hint">
                    <span className="ops-mono">{bad.name}</span>: {bad.reason}
                  </p>
                ))}
              </div>
            )}
          </Section>
        )}
        {active === "mcp" && (
          <Section title="MCP servers" blurb="Servers in mcp.json at the workspace root, the way Claude Code declares them. Each tool a server offers is risky until you floor it safe by name or glob in the file; KOS never guesses.">
            {/* Two doors: a name and a command line or URL, or a block pasted
                from a README in Claude Code's shape. Both write the file and
                bring the server up at once. */}
            <div className="set-group">
              <h3>Add a server</h3>
              <form
                className="set-instance-new set-install"
                onSubmit={(e) => {
                  e.preventDefault();
                  addMcpFromDraft();
                }}
              >
                <input
                  className="kos-input set-install-name"
                  placeholder="Name, e.g. browser"
                  value={mcpDraft.name}
                  onChange={(e) => setMcpDraft((d) => ({ ...d, name: e.target.value }))}
                />
                <input
                  className="kos-input"
                  placeholder="Command line (npx @playwright/mcp@latest) or URL (https://…/mcp)"
                  value={mcpDraft.where}
                  onChange={(e) => setMcpDraft((d) => ({ ...d, where: e.target.value }))}
                />
                <select
                  className="kos-input set-install-risk"
                  aria-label="Risk floor"
                  value={mcpDraft.risk}
                  onChange={(e) => setMcpDraft((d) => ({ ...d, risk: e.target.value === "safe" ? "safe" : "risky" }))}
                >
                  <option value="risky">risky: each call asks</option>
                  <option value="safe">safe: every tool runs</option>
                </select>
                <button type="submit" className="btn btn--sm" disabled={mcpBusy !== null || !mcpDraft.name.trim() || !mcpDraft.where.trim()}>
                  {mcpBusy === "add" ? "Adding…" : "Add"}
                </button>
              </form>
              <form
                className="set-install-json"
                onSubmit={(e) => {
                  e.preventDefault();
                  addMcpFromJson();
                }}
              >
                <textarea
                  className="ops-textarea"
                  rows={4}
                  placeholder={'Or paste a config: {"mcpServers": {"browser": {"command": "npx", "args": ["@playwright/mcp@latest"]}}}'}
                  value={mcpJson}
                  onChange={(e) => setMcpJson(e.target.value)}
                />
                <button type="submit" className="btn btn--sm" disabled={mcpBusy !== null || !mcpJson.trim()}>
                  {mcpBusy === "json" ? "Adding…" : "Add from JSON"}
                </button>
              </form>
            </div>
            {mcp.length === 0 && <p className="hint">No servers in mcp.json yet.</p>}
            {mcp.map((s) => (
              <Field
                key={s.name}
                label={`${s.name} (${s.transport})${s.projects.length ? ` · ${s.projects.join(", ")}` : ""}`}
                hint={
                  !s.enabled
                    ? `${s.command} · off`
                    : s.error
                      ? `${s.command} · not connected: ${s.error}`
                      : s.connected
                        ? `${s.command} · serving ${s.tools?.length ?? 0} tool${s.tools?.length === 1 ? "" : "s"}`
                        : `${s.command} · starting`
                }
              >
                <label className="set-toggle">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={mcpBusy === s.name}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setMcpBusy(s.name);
                      void api.setMcpServerEnabled(s.name, enabled).then(loadMcp, loadMcp).finally(() => setMcpBusy(null));
                    }}
                  />
                  <span>{mcpBusy === s.name ? "…" : s.enabled ? "On" : "Off"}</span>
                </label>
                <span className="set-module-actions">
                  <span className="hint">
                    {s.risk === "safe" ? "all tools safe" : "risky"}
                    {Object.keys(s.floors).length > 0 && ` · floors: ${Object.entries(s.floors).map(([t, f]) => `${t} ${f}`).join(", ")}`}
                  </span>
                  <button
                    type="button"
                    className="link is-danger"
                    disabled={mcpBusy === s.name}
                    onClick={() => {
                      setMcpBusy(s.name);
                      void api.removeMcpServer(s.name).then(loadMcp).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setMcpBusy(null));
                    }}
                  >
                    Remove
                  </button>
                </span>
              </Field>
            ))}
          </Section>
        )}
        {active === "modules" && (
          <Section title="Modules" blurb="Each one is a folder under modules/ with a module.json. A server module runs tools, and off is the default: nothing runs until you switch it on here. A blueprint is a project template; each instance is a project of its own.">
            {(modules.builtins ?? []).length > 0 && (
              <div className="set-group">
                <h3>Built in</h3>
                <p className="hint">Features the kernel ships but does not insist on. Off takes their tools away at once; on brings them back.</p>
                {(modules.builtins ?? []).map((b) => (
                  <Field key={b.name} label={b.name} hint={b.description}>
                    <label className="set-toggle">
                      <input
                        type="checkbox"
                        checked={b.enabled}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          void api.setModuleEnabled(b.name, enabled).then(loadModules, loadModules);
                        }}
                      />
                      <span>{b.enabled ? "On" : "Off"}</span>
                    </label>
                  </Field>
                ))}
              </div>
            )}
            {modules.modules.length === 0 && modules.invalid.length === 0 && (
              <p className="hint">No workspace modules yet. Ask KOS to make one with modules.create, install one below, or add a folder under modules/.</p>
            )}
            {/* The second rung of the spec's distribution path: a repository
                per module. Installed is off; nothing runs until switched on. */}
            <form
              className="set-instance-new set-install"
              onSubmit={(e) => {
                e.preventDefault();
                const source = installSource.trim();
                if (!source) return;
                setModuleBusy("install");
                void api
                  .installModule(source)
                  .then(() => {
                    setInstallSource("");
                    loadModules();
                  })
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setModuleBusy(null));
              }}
            >
              <input
                className="kos-input"
                placeholder="Install from a git URL or a folder path"
                value={installSource}
                onChange={(e) => setInstallSource(e.target.value)}
              />
              <button type="submit" className="btn btn--sm" disabled={moduleBusy === "install" || !installSource.trim()}>
                {moduleBusy === "install" ? "…" : "Install"}
              </button>
            </form>
            {modules.modules.map((m) => (
              <Field
                key={m.name}
                label={m.name}
                hint={
                  m.blueprint
                    ? `${m.description} · blueprint: ${m.blueprint.schema} schema change${m.blueprint.schema === 1 ? "" : "s"}, ${m.blueprint.pages} page${m.blueprint.pages === 1 ? "" : "s"}, ${m.blueprint.jobs} job${m.blueprint.jobs === 1 ? "" : "s"}`
                    : m.error
                      ? `${m.description} · not connected: ${m.error}`
                      : m.connected && m.tools
                        ? `${m.description} · serving ${m.tools.length} tool${m.tools.length === 1 ? "" : "s"}`
                        : m.description
                }
              >
                {m.blueprint ? (
                  /* A template has nothing to switch on. What it has is
                     instances, and room for one more. */
                  <div className="set-instances">
                    {m.blueprint.instances.length === 0 ? (
                      <span className="hint">No instances yet.</span>
                    ) : (
                      <span className="set-instance-list">
                        {m.blueprint.instances.map((p) => (
                          <a key={p.slug} className="ops-page-chip" href={`#/chats/project%3A${encodeURIComponent(p.slug)}`} title={`Open ${p.name}'s chat`}>
                            {p.name}
                          </a>
                        ))}
                      </span>
                    )}
                    {(m.blueprint.instancing === "multi" || m.blueprint.instances.length === 0) && (
                      <form
                        className="set-instance-new"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const name = (newInstance[m.name] ?? "").trim();
                          if (!name) return;
                          setModuleBusy(m.name);
                          void api
                            .instantiateModule(m.name, name)
                            .then(() => {
                              setNewInstance((cur) => ({ ...cur, [m.name]: "" }));
                              loadModules();
                            })
                            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                            .finally(() => setModuleBusy(null));
                        }}
                      >
                        <input
                          className="kos-input"
                          placeholder="New instance, e.g. Household 2026"
                          value={newInstance[m.name] ?? ""}
                          onChange={(e) => setNewInstance((cur) => ({ ...cur, [m.name]: e.target.value }))}
                        />
                        <button type="submit" className="btn btn--sm" disabled={moduleBusy === m.name || !(newInstance[m.name] ?? "").trim()}>
                          {moduleBusy === m.name ? "…" : "Create"}
                        </button>
                      </form>
                    )}
                  </div>
                ) : (
                <label className="set-toggle">
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    disabled={moduleBusy === m.name}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      // The server comes up or goes down on the save, so the
                      // list is re-read afterwards to show what happened.
                      setModuleBusy(m.name);
                      void api.setModuleEnabled(m.name, enabled).then(loadModules, loadModules).finally(() => setModuleBusy(null));
                    }}
                  />
                  <span>{moduleBusy === m.name ? "…" : m.enabled ? "On" : "Off"}</span>
                </label>
                )}
                <span className="set-module-actions">
                  {m.origin && (
                    <button
                      type="button"
                      className="link"
                      disabled={moduleBusy === m.name}
                      onClick={() => {
                        setModuleBusy(m.name);
                        void api.updateModule(m.name).then(loadModules).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setModuleBusy(null));
                      }}
                    >
                      Update
                    </button>
                  )}
                  <button
                    type="button"
                    className="link is-danger"
                    disabled={moduleBusy === m.name}
                    onClick={() => {
                      setModuleBusy(m.name);
                      void api.removeModule(m.name).then(loadModules).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setModuleBusy(null));
                    }}
                  >
                    Remove
                  </button>
                  {m.origin && <span className="hint ops-mono">{m.origin}</span>}
                </span>
              </Field>
            ))}
            {modules.invalid.length > 0 && (
              <div className="set-group">
                <h3>Could not be read</h3>
                {modules.invalid.map((bad) => (
                  <p key={bad.name} className="hint">
                    <span className="ops-mono">{bad.name}</span>: {bad.reason}
                  </p>
                ))}
              </div>
            )}
          </Section>
        )}
        {active === "permissions" && (
          <Section title="Permissions" blurb="Each rule is a decision you made at a prompt with Always. The same shape stops asking; a new shape still does. Revoke one and it asks again.">
            {rules.length === 0 && (
              <p className="hint">Nothing kept yet. When KOS asks before a risky action, Always approves it and keeps the decision for that shape.</p>
            )}
            {rules.map((r) => (
              <Field
                key={r.id}
                label={`${r.tool}${r.scope ? ` · ${r.scope}` : ""}`}
                hint={r.project ? `In project ${r.project}` : "Everywhere"}
              >
                <button
                  type="button"
                  className="btn btn--sm btn--danger-ghost"
                  onClick={() => {
                    void api.revokePermission(r.id).then(loadRules, loadRules);
                  }}
                >
                  Revoke
                </button>
              </Field>
            ))}
          </Section>
        )}
        {active === "spend" && (
          <Section title="Spend" blurb="Tokens as the provider counted them.">
            <SpendPanel />
          </Section>
        )}

        {active === "workspace" && (
          <Section
            title="Workspace"
            blurb="One folder holds everything KOS owns. The agent cannot see outside it."
          >
            <dl className="set-facts">
              <dt>Workspace</dt>
              <dd>
                <code>{data.workspace}</code>
              </dd>
              <dt>Settings file</dt>
              <dd>
                <code>{data.envPath ?? "none"}</code>
                <span className="set-hint">
                  Deliberately outside the workspace: that is what stops the
                  agent reading your keys.
                </span>
              </dd>
              {data.sitesUrl && (
                <>
                  <dt>Sites served at</dt>
                  <dd>
                    <code>{data.sitesUrl}</code>
                  </dd>
                </>
              )}
              <dt>Agent</dt>
              <dd>
                {data.halted ? (
                  <span className="set-badge is-halted">halted</span>
                ) : (
                  <span className="set-badge is-set">running</span>
                )}
              </dd>
            </dl>
            <div className="set-inline">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void api
                    .openWorkspace()
                    .then(() => done("workspace", "Opened"))
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err.message : String(err)),
                    );
                }}
              >
                Open folder
              </button>
              <button
                type="button"
                className={data.halted ? "btn btn--primary" : "btn btn--danger"}
                onClick={() =>
                  run("workspace", api.setKill(!data.halted), data.halted ? "Resumed" : "Halted")
                }
              >
                {data.halted ? "Resume KOS" : "Halt KOS"}
              </button>
              {saved.workspace && <span className="set-saved">{saved.workspace}</span>}
            </div>
            <p className="set-note">
              Halting stops every turn and scheduled job until you resume. The
              workspace is chosen when the host starts, with{" "}
              <code>--workspace</code>, so pointing KOS at a different folder is
              a restart rather than a setting.
            </p>
          </Section>
        )}
      </m.div>
    </div>
  );
}

export type { ModelRate };
