import { useEffect, useState, type ReactElement } from "react";

import { api, type ModelSettings as Settings, type TaskModelSetting } from "./api.js";
import { Select } from "./Select.js";

/**
 * Which model answers, how hard it thinks, and how much it may write.
 *
 * Two task classes because that is what the router dispatches on: reasoning is
 * every real turn, cheap is the salience pass that decides what to remember.
 * The model list is fetched from the provider rather than kept here, since a
 * hard-coded list is how the OpenAI route sat on gpt-4o long after better
 * models existed.
 */

const TASKS: Array<{ key: "reasoning" | "cheap"; label: string; hint: string }> = [
  { key: "reasoning", label: "Reasoning", hint: "every chat turn and scheduled job" },
  { key: "cheap", label: "Cheap", hint: "deciding what is worth remembering" },
];

export function ModelSettings({
  onClose,
}: {
  /** Absent on the settings page, where there is no sheet to close. */
  onClose?: () => void;
}): ReactElement {
  const [saved, setSaved] = useState<Settings>({});
  const [routes, setRoutes] = useState<Record<
    string,
    { model: string; effort?: string; maxTokens?: number }
  > | null>(null);
  const [efforts, setEfforts] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .modelSettings()
      .then((s) => {
        setSaved(s.saved ?? {});
        setRoutes(s.routes);
        setEfforts(s.efforts ?? []);
      })
      .catch(() => setStatus("Could not load settings."));
    // A provider that cannot list its models is not a reason to block editing:
    // the field stays typeable and the dropdown simply has nothing to offer.
    void api
      .availableModels()
      .then((r) => setModels(r.models))
      .catch((err: unknown) =>
        setListError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  const update = (task: "reasoning" | "cheap", patch: TaskModelSetting): void => {
    setSaved((s) => ({ ...s, [task]: { ...s[task], ...patch } }));
    setStatus(null);
  };

  const save = (): void => {
    void api
      .saveModelSettings(saved)
      .then(() => setStatus("Saved. Takes effect on the next turn."))
      .catch((err: unknown) =>
        setStatus(err instanceof Error ? err.message : String(err)),
      );
  };

  return (
    <div className="settings">
      {/* No heading here: the modal already has the title, and a second one
          scrolled up under it. */}
      <p className="hint">
        Applied on the next turn, no restart. Leave a field blank to keep the
        default.
      </p>

      {TASKS.map(({ key, label, hint }) => {
        const setting = saved[key] ?? {};
        const route = routes?.[key];
        const active = route?.model;
        return (
          <section className="settings-group" key={key}>
            <div className="settings-group-head">
              <strong>{label}</strong>
              <span className="hint">{hint}</span>
            </div>

            <label className="kos-field">
              <span className="kos-field-label">Model</span>
              <input
                className="kos-input"
                list={`models-${key}`}
                placeholder={active ?? "provider default"}
                value={setting.model ?? ""}
                onChange={(e) => update(key, { model: e.target.value })}
              />
              <datalist id={`models-${key}`}>
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>

            <div className="settings-row">
              <div className="kos-field">
                <span className="kos-field-label">Thinking</span>
                <Select
                  className="settings-select"
                  label="Thinking level"
                  value={setting.effort ?? ""}
                  options={[
                    { value: "", label: "default" },
                    ...efforts.map((e) => ({ value: e, label: e })),
                  ]}
                  onChange={(effort) => update(key, { effort })}
                />
              </div>

              <label className="kos-field">
                <span className="kos-field-label">Token limit</span>
                <input
                  className="kos-input"
                  type="number"
                  min={256}
                  step={256}
                  placeholder="default"
                  value={setting.maxTokens ?? ""}
                  onChange={(e) =>
                    update(key, {
                      maxTokens: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </label>
            </div>

            {/* What is actually in force, so a saved setting can be read back
                rather than only written. */}
            {route && (
              <div className="settings-now">
                now: <code>{route.model}</code>
                {route.effort ? ` · ${route.effort} thinking` : ""}
                {route.maxTokens ? ` · ${route.maxTokens} tokens` : ""}
              </div>
            )}
          </section>
        );
      })}

      {listError && (
        <p className="hint">
          Could not list models from the provider ({listError}). Type a model id
          instead.
        </p>
      )}

      <div className="settings-actions">
        <button type="button" className="btn btn--primary" onClick={save}>
          Save
        </button>
        {onClose && (
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        )}
        {status && <span className="hint">{status}</span>}
      </div>
    </div>
  );
}
