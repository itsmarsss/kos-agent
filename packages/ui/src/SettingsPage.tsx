import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import {
  api,
  type Behaviour,
  type ModelRate,
  type SettingsPayload,
} from "./api.js";
import { ModelSettings } from "./ModelSettings.js";
import { Select } from "./Select.js";
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
  | "network"
  | "spend"
  | "workspace";

const SECTIONS: { id: SectionId; label: string; blurb: string }[] = [
  { id: "you", label: "You", blurb: "Who KOS thinks it is working for" },
  { id: "providers", label: "Providers", blurb: "API keys and channel credentials" },
  { id: "models", label: "Models", blurb: "Which model answers, and which builds" },
  { id: "conversation", label: "Conversation", blurb: "How much history is kept" },
  {
    id: "behaviour",
    label: "Behaviour",
    blurb: "How KOS acts when you are not watching",
  },
  { id: "network", label: "Network", blurb: "Ports, binding, and what the agent may reach" },
  { id: "spend", label: "Spend", blurb: "Tokens used and what they cost" },
  { id: "workspace", label: "Workspace", blurb: "Where everything lives" },
];

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

function Section({
  title,
  blurb,
  children,
  onSave,
  saving,
  saved,
}: {
  title: string;
  blurb: string;
  children: ReactNode;
  onSave?: () => void;
  saving?: boolean;
  saved?: string | null;
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
            disabled={saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && <span className="set-saved">{saved}</span>}
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

export function SettingsPage(): ReactElement {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SectionId>("you");
  const [how, setHow] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  /** The last values the server confirmed, so an edit can be seen as one. */
  const [savedHow, setSavedHow] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  const [defaults, setDefaults] = useState<Behaviour>(BEHAVIOUR_FALLBACK);
  const [limits, setLimits] = useState<Record<string, [number, number]>>({});
  /** ModelSettings owns its draft, so it hands its save up to the footer. */
  const saveModels = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState<SectionId | null>(null);
  const [saved, setSaved] = useState<Partial<Record<SectionId, string>>>({});

  const [profile, setProfile] = useState({ name: "", timezone: "" });
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [buildModel, setBuildModel] = useState("");
  const [retention, setRetention] = useState({
    maxChars: "",
    maxToolResultChars: "",
    maxExchanges: "",
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
        {SECTIONS.map((s) => (
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
      </nav>

      <div className="set-pane">
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
            saving={busy === "you"}
            saved={saved.you ?? null}
            onSave={() =>
              run(
                "you",
                api.saveProfile(profile.name, profile.timezone),
                "Saved",
              )
            }
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
            saving={busy === "providers"}
            saved={saved.providers ?? null}
            onSave={() => saveEnv("providers", keys, () => setKeys({}))}
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
          <>
            {/* First, because it decides whether the rest of this tab even
                applies: on the subscription the model is the SDK's to pick. */}
            <Section
              title="Who does the thinking"
              blurb="A turn can go to the model provider, which bills API credits, or through the Claude Agent SDK, which is what coding agents already use and spends a Claude Code subscription instead."
              saving={busy === "engine"}
              saved={saved.engine ?? null}
              onSave={() => run("engine", api.saveBehaviour(how), "Saved")}
            >
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
            </Section>

            <Section
              title="Models"
              blurb="Which model answers what, and how hard it thinks."
              saving={busy === "models"}
              saved={saved.models ?? null}
              onSave={() => saveModels.current?.()}
            >
              <ModelSettings onReady={(fn) => (saveModels.current = fn)} />
            </Section>
            <Section
              title="Build agents"
              blurb="Which model does the building when KOS hands work to a coding sub-agent."
              saving={busy === "models"}
              saved={saved.models ?? null}
              onSave={() => run("models", api.saveBuildModel(buildModel), "Saved")}
            >
              <Field
                label="Build model"
                hint="A build is many turns and each is a model call, so this is the biggest lever on how long one takes. Sonnet is markedly faster than Opus for scaffolding work. Leave blank to use whatever Claude Code defaults to."
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
            </Section>
          </>
        )}

        {active === "behaviour" && (
          <>
            <Section
              title="When something fails"
              blurb="A job that fails at 3am tells you either way. This decides whether KOS also tries to do something about it before you wake up."
            >
              <Field
                label="Try to fix failures on its own"
                hint="On the first failure of a job, KOS opens a chat, works out why, and repairs it if it safely can. Later failures of the same job do not start another attempt. Everything it does there still asks you before anything risky, and you can read or steer the attempt in Chats."
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
            </Section>

            <Section
              title="How hard it tries"
              blurb="A step is one round-trip to the model, which is roughly one thought and one tool call. Past the limit a turn stops and says it got stuck rather than running on."
            >
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
            </Section>

            <Section
              title="Unattended work"
              blurb="Limits on what KOS may do while nobody is watching. These are the guards against a loop that runs all night."
            >
              <div className="set-grid">
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
            </Section>

            {/* One set of buttons, because these three cards are one stored
                document. A Save under each would each write all of them,
                which reads as three independent settings and is not. Drawn
                as a card footer so it matches every other Save on the page. */}
            <footer className="set-card set-card-foot">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy === "behaviour" || !changed}
                onClick={saveHow}
              >
                {busy === "behaviour" ? "Saving…" : "Save behaviour"}
              </button>
              {/* Fills the fields rather than writing them: you get to see
                  what reverting would do before it is the setting. */}
              <button
                type="button"
                className="btn"
                disabled={busy === "behaviour" || atDefaults}
                onClick={() => setHow(defaults)}
              >
                Reset to defaults
              </button>
              {changed ? (
                <span className="set-unsaved">Not saved yet</span>
              ) : (
                saved.behaviour && (
                  <span className="set-saved">{saved.behaviour}</span>
                )
              )}
            </footer>
          </>
        )}

        {active === "conversation" && (
          <Section
            title="Conversation"
            blurb="How much of a chat is carried into the next turn. Past these, the oldest exchanges fall off the front; /compact turns them into a summary instead."
            saving={busy === "conversation"}
            saved={saved.conversation ?? null}
            onSave={() =>
              run(
                "conversation",
                api.saveRetention({
                  maxChars: Number(retention.maxChars),
                  maxToolResultChars: Number(retention.maxToolResultChars),
                  maxExchanges: Number(retention.maxExchanges),
                }),
                "Saved",
              )
            }
          >
            <Field
              label="History budget"
              hint={`Characters of a conversation kept. Default ${data.retentionDefaults.maxChars.toLocaleString()}.`}
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
              hint={`Hard ceiling regardless of size. Default ${data.retentionDefaults.maxExchanges}.`}
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
              hint={`A single result longer than this is truncated rather than dropped. Default ${data.retentionDefaults.maxToolResultChars.toLocaleString()}.`}
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
            saving={busy === "network"}
            saved={saved.network ?? null}
            onSave={() => saveEnv("network", ports, () => setPorts({}))}
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
                  placeholder={meta.value || "none"}
                  onChange={(e) => setPorts((p) => ({ ...p, [key]: e.target.value }))}
                />
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
      </div>
    </div>
  );
}

export type { ModelRate };
