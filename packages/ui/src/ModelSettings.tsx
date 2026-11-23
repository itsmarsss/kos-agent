import { useEffect, useState, type ReactElement } from "react";
import { providerWord } from "@kos/shared";

import { api, type ModelSettings as Settings, type TaskModelSetting } from "./api.js";
import { Select } from "./Select.js";

/**
 * Which model answers, how hard it thinks, and how much it may write.
 *
 * The task classes the router dispatches on, named for the owner: the model
 * for thinking is every real turn, the cheap model the salience pass that
 * decides what to remember, and the screen model is
 * the looking and clicking a turn hands on once it has chosen what to do there.
 * The model list is fetched from the provider rather than kept here, since a
 * hard-coded list is how the OpenAI route sat on gpt-4o long after better
 * models existed.
 */

type TaskKey = "reasoning" | "cheap" | "screen";

const TASKS: Array<{ key: TaskKey; label: string; hint: string }> = [
  { key: "reasoning", label: "The model for thinking", hint: "answers every chat and runs every schedule" },
  { key: "cheap", label: "The cheap model", hint: "small tasks, like deciding what is worth remembering" },
  { key: "screen", label: "The screen model", hint: "clicks and looks on a computer or in Chrome; the thinking model unless you pick another" },
];

export function ModelSettings({
  onClose,
  onReady,
}: {
  /** Absent on the settings page, where there is no sheet to close. */
  onClose?: () => void;
  /**
   * Hands the save back to whoever is wrapping this, along with whether the
   * draft differs from what is stored, so the button can live in the card's
   * own footer with every other section's and behave the same way. Given
   * one, the inline button is not drawn.
   */
  onReady?: (save: () => void, dirty: boolean) => void;
}): ReactElement {
  const [saved, setSaved] = useState<Settings>({});
  const [routes, setRoutes] = useState<Record<
    string,
    { provider: string; model: string; effort?: string; maxTokens?: number }
  > | null>(null);
  const [efforts, setEfforts] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [customUrl, setCustomUrl] = useState("");
  const [customSaved, setCustomSaved] = useState("");
  const [customStatus, setCustomStatus] = useState<string | null>(null);
  const [classifierUrl, setClassifierUrl] = useState("");
  const [classifierSaved, setClassifierSaved] = useState("");
  const [classifierStatus, setClassifierStatus] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  /** What the server last confirmed, so an edit can be told from a load. */
  const [stored, setStored] = useState<Settings>({});
  const [status, setStatus] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .modelSettings()
      .then((s) => {
        setSaved(s.saved ?? {});
        setStored(s.saved ?? {});
        setRoutes(s.routes);
        setEfforts(s.efforts ?? []);
        setProviders(s.providers ?? []);
        setCustomUrl(s.custom?.baseUrl ?? "");
        setCustomSaved(s.custom?.baseUrl ?? "");
        setClassifierUrl(s.classifier?.url ?? "");
        setClassifierSaved(s.classifier?.url ?? "");
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

  const update = (task: TaskKey, patch: TaskModelSetting): void => {
    setSaved((s) => ({ ...s, [task]: { ...s[task], ...patch } }));
    setStatus(null);
  };

  /** Whether anything here differs from what the server last confirmed. */
  const dirty = JSON.stringify(saved) !== JSON.stringify(stored);

  const save = (): void => {
    void api
      .saveModelSettings(saved)
      .then(() => {
        setStored(saved);
        setStatus("Saved. Used from the next message.");
      })
      .catch((err: unknown) =>
        setStatus(err instanceof Error ? err.message : String(err)),
      );
  };

  // Registered after every render so the callback closes over current state
  // rather than over whatever it was on mount.
  useEffect(() => {
    onReady?.(save, dirty);
  });

  return (
    <div className="settings">
      {/* No heading and no line of its own: the section above it says when this applies, once. */}

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

            <div className="kos-field">
              <span className="kos-field-label">Provider</span>
              <Select
                className="settings-select"
                label="Provider"
                value={setting.provider ?? ""}
                options={[
                  { value: "", label: route?.provider ? `As now (${providerWord(route.provider)})` : "The usual one" },
                  ...providers.map((p) => ({ value: p, label: providerWord(p) })),
                ]}
                onChange={(provider) => update(key, { provider: provider || undefined })}
              />
            </div>

            <label className="kos-field">
              <span className="kos-field-label">Model</span>
              <input
                className="kos-input"
                list={`models-${key}`}
                placeholder={active ? `${active}, as now` : "The provider's usual model"}
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
                    { value: "", label: "Usual" },
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
                  placeholder="Usual"
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
                In use now: {providerWord(route.provider)}, <code>{route.model}</code>
                {route.effort ? ` · ${route.effort} thinking` : ""}
                {route.maxTokens ? ` · ${route.maxTokens} tokens` : ""}
              </div>
            )}
          </section>
        );
      })}

      {listError && (
        <p className="hint">
          The provider would not list its models, so type the model's name
          instead.
        </p>
      )}

      <details className="settings-more">
        <summary>Advanced: your own model server, and a classifier</summary>
      <section className="settings-group">
        <div className="settings-group-head">
          <strong>Your own model server</strong>
          <span className="hint">any OpenAI-compatible server: your model, a local one, a gateway</span>
        </div>
        <label className="kos-field">
          <span className="kos-field-label">Base URL</span>
          <input
            className="kos-input"
            placeholder="http://127.0.0.1:11434/v1"
            value={customUrl}
            onChange={(e) => { setCustomUrl(e.target.value); setCustomStatus(null); }}
          />
        </label>
        <p className="hint">
          Saved on its own and used at once. If the server needs a key, set it under Providers.
          Then pick "Your own server" as a provider above and type the name of the model it serves.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="btn"
            disabled={customUrl.trim() === customSaved}
            onClick={() => {
              void api
                .saveCustomEndpoint(customUrl.trim())
                .then((r) => {
                  setCustomSaved(r.custom?.baseUrl ?? "");
                  setCustomUrl(r.custom?.baseUrl ?? "");
                  setProviders(r.providers);
                  setCustomStatus(r.custom ? "Endpoint saved." : "Endpoint removed.");
                })
                .catch((err: unknown) => setCustomStatus(err instanceof Error ? err.message : String(err)));
            }}
          >
            Save endpoint
          </button>
          {customStatus && <span className="hint">{customStatus}</span>}
        </div>
      </section>

      <section className="settings-group">
        <div className="settings-group-head">
          <strong>Classifier</strong>
          <span className="hint">optional: a small model of your own that sorts messages</span>
        </div>
        <label className="kos-field">
          <span className="kos-field-label">Endpoint URL</span>
          <input
            className="kos-input"
            placeholder="https://.../classify"
            value={classifierUrl}
            onChange={(e) => { setClassifierUrl(e.target.value); setClassifierStatus(null); }}
          />
        </label>
        <p className="hint">
          KOS asks it whether a message is worth remembering. Without one, the cheap model decides; the thinking model never does. If it needs a key, set it under Providers.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="btn"
            disabled={classifierUrl.trim() === classifierSaved}
            onClick={() => {
              void api
                .saveClassifierEndpoint(classifierUrl.trim())
                .then((r) => {
                  setClassifierSaved(r.classifier?.url ?? "");
                  setClassifierUrl(r.classifier?.url ?? "");
                  setClassifierStatus(r.classifier ? "Classifier saved." : "The cheap model sorts messages again.");
                })
                .catch((err: unknown) => setClassifierStatus(err instanceof Error ? err.message : String(err)));
            }}
          >
            Save classifier
          </button>
          {classifierStatus && <span className="hint">{classifierStatus}</span>}
        </div>
      </section>
      </details>

      <div className="settings-actions">
        {!onReady && (
          <button type="button" className="btn btn--primary" onClick={save}>
            Save
          </button>
        )}
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
