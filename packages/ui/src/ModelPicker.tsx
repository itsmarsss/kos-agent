import { useEffect, useState, type ReactElement } from "react";

import { api } from "./api.js";
import { Select } from "./Select.js";

/**
 * Swap the reasoning model without leaving the conversation.
 *
 * The full settings live in a modal, but changing which model answers is a
 * per-message decision often enough that it belongs beside the send button.
 */
export function ModelPicker(): ReactElement | null {
  const [models, setModels] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<"api" | "sdk">("api");

  useEffect(() => {
    void api
      .modelSettings()
      .then((s) => setCurrent(s.routes?.["reasoning"]?.model ?? ""))
      .catch(() => undefined);
    void api
      .availableModels()
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
    void api
      .behaviour()
      .then((r) => setEngine(r.behaviour.engine))
      .catch(() => undefined);
  }, []);

  /*
   * On the subscription the model is the SDK's to choose, and this control
   * writes the provider routing, which that path does not read. Showing a
   * pickable model there would be a lie about what answers.
   */
  if (engine === "sdk") {
    return (
      <span className="composer-engine" title="Answering on your Claude Code subscription. Change it in Settings, Models.">
        Claude Agent SDK
      </span>
    );
  }

  // Nothing to choose between is not a control, it is clutter.
  if (!current || models.length === 0) return null;

  const options = models.includes(current) ? models : [current, ...models];

  return (
    <Select
      className="composer-model"
      label="Model"
      value={current}
      disabled={busy}
      options={options.map((m) => ({ value: m, label: m }))}
      onChange={(model) => {
        setCurrent(model);
        setBusy(true);
        void api
          .saveModelSettings({ reasoning: { model } })
          .finally(() => setBusy(false));
      }}
    />
  );
}
