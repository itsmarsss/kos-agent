import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { api, type ModelRate, type SettingsPayload } from "./api.js";
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

type SectionId =
  | "you"
  | "providers"
  | "models"
  | "conversation"
  | "failures"
  | "network"
  | "spend"
  | "workspace";

const SECTIONS: { id: SectionId; label: string; blurb: string }[] = [
  { id: "you", label: "You", blurb: "Who KOS thinks it is working for" },
  { id: "providers", label: "Providers", blurb: "API keys and channel credentials" },
  { id: "models", label: "Models", blurb: "Which model answers, and which builds" },
  { id: "conversation", label: "Conversation", blurb: "How much history is kept" },
  {
    id: "failures",
    label: "Failures",
    blurb: "What happens when something breaks",
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
  const [autofix, setAutofix] = useState(false);
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
      .autofix()
      .then((r) => setAutofix(r.enabled))
      // A setting that cannot be read stays off, which is the safe reading.
      .catch(() => setAutofix(false));
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
            <Section title="Models" blurb="Which model answers what, and how hard it thinks.">
              <ModelSettings />
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

        {active === "failures" && (
          <Section
            title="Failures"
            blurb="A job that fails at 3am tells you either way. This decides whether KOS also tries to do something about it before you wake up."
          >
            <Field
              label="Try to fix failures on its own"
              hint="On the first failure of a job, KOS opens a chat, works out why, and repairs it if it safely can. Later failures of the same job do not start another attempt. Everything it does there still asks you before anything risky, and you can read or steer the attempt in Chats."
            >
              <label className="set-toggle">
                <input
                  type="checkbox"
                  checked={autofix}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setAutofix(next);
                    // Saved as it is flipped: one switch does not need a
                    // Save button parked underneath it.
                    void api.setAutofix(next).catch(() => setAutofix(!next));
                  }}
                />
                <span>{autofix ? "On" : "Off"}</span>
              </label>
            </Field>
          </Section>
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
