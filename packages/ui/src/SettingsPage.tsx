import { useEffect, useState, type ReactElement } from "react";

import { api, type SettingsPayload } from "./api.js";
import { ModelSettings } from "./ModelSettings.js";
import { SpendPanel } from "./SpendPanel.js";

/**
 * Everything you would otherwise have opened a dotfile to change.
 *
 * Keys are write-only from here. What comes back is whether one is set and its
 * last four characters, which is enough to tell two apart and no use to
 * anyone; the value itself never leaves the machine it is stored on. Saving
 * applies to the running process as well as the file, so a key set here works
 * on the next turn rather than after a restart.
 */

function Field({
  label,
  hint,
  placeholder,
  value,
  onChange,
  secret,
  current,
}: {
  label: string;
  hint: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  /** What is stored now, masked, when something is. */
  current?: string | null;
}): ReactElement {
  return (
    <label className="set-field">
      <span className="set-label">
        {label}
        {current && <span className="set-current">set · {current}</span>}
      </span>
      <input
        className="kos-input"
        type={secret ? "password" : "text"}
        value={value}
        autoComplete={secret ? "new-password" : "off"}
        placeholder={current ? "unchanged" : (placeholder ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="hint">{hint}</span>
    </label>
  );
}

export function SettingsPage(): ReactElement {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (): void => {
    void api
      .settings()
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(load, []);

  const save = (): void => {
    // Only what was actually typed. An untouched field must not be sent as an
    // empty string, which would read as "clear this key".
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (value !== "") values[key] = value;
    }
    if (Object.keys(values).length === 0) {
      setSaved("Nothing changed.");
      return;
    }
    setSaving(true);
    void api
      .saveSettings(values)
      .then((r) => {
        setDraft({});
        setSaved(
          r.written.length
            ? `Saved ${r.written.length} setting${r.written.length === 1 ? "" : "s"}.`
            : "Nothing changed.",
        );
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setSaving(false));
  };

  const clear = (key: string): void => {
    setSaving(true);
    void api
      .saveSettings({ [key]: "" })
      .then(() => {
        setSaved("Cleared.");
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setSaving(false));
  };

  const set = (key: string, value: string): void =>
    setDraft((d) => ({ ...d, [key]: value }));

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

  return (
    <div className="settings-page">
      <header className="set-head">
        <h1>Settings</h1>
      </header>

      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="ops-alert" role="status">
          {saved}
        </p>
      )}

      <section className="set-section">
        <h2>This workspace</h2>
        <dl className="set-facts">
          <dt>Workspace</dt>
          <dd>
            <code>{data.workspace}</code>
          </dd>
          <dt>Settings file</dt>
          <dd>
            <code>{data.envPath ?? "none"}</code>
          </dd>
          {data.sitesUrl && (
            <>
              <dt>Sites served at</dt>
              <dd>
                <code>{data.sitesUrl}</code>
              </dd>
            </>
          )}
        </dl>
        {!data.envWritable && (
          <p className="ops-alert ops-alert--err" role="alert">
            {data.envPath
              ? "The settings file is inside the workspace, so keys cannot be saved there: the agent can read anything in the workspace. Move it out and restart."
              : "This host was started without a settings file, so keys cannot be saved from here."}
          </p>
        )}
        <p className="hint">
          The workspace is set when the host starts, with{" "}
          <code>--workspace</code> or <code>KOS_WORKSPACE</code>. Changing it
          means pointing KOS at a different folder, so it is a restart rather
          than a setting.
        </p>
      </section>

      <section className="set-section">
        <h2>Providers</h2>
        <p className="hint">
          Stored outside the workspace, in the settings file above, readable
          only by you. KOS shows the last four characters so you can tell two
          keys apart; it never sends the value back.
        </p>
        {Object.entries(data.secrets).map(([key, meta]) => (
          <div className="set-row" key={key}>
            <Field
              label={meta.label}
              hint={meta.hint}
              secret={!key.endsWith("OWNER_DISCORD")}
              value={draft[key] ?? ""}
              current={meta.masked}
              onChange={(v) => set(key, v)}
            />
            {meta.masked && (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={saving}
                onClick={() => clear(key)}
              >
                Clear
              </button>
            )}
          </div>
        ))}
      </section>

      <section className="set-section">
        <h2>Ports</h2>
        <p className="hint">Applied the next time the host starts.</p>
        {Object.entries(data.settings).map(([key, meta]) => (
          <Field
            key={key}
            label={meta.label}
            hint={meta.hint}
            placeholder={meta.value || undefined}
            value={draft[key] ?? ""}
            onChange={(v) => set(key, v)}
          />
        ))}
      </section>

      <div className="set-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving || !data.envWritable}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <section className="set-section">
        <h2>Models</h2>
        <ModelSettings />
      </section>

      <SpendPanel />
    </div>
  );
}
