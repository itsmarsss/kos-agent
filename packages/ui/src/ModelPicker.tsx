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

  useEffect(() => {
    void api
      .modelSettings()
      .then((s) => setCurrent(s.routes?.["reasoning"]?.model ?? ""))
      .catch(() => undefined);
    void api
      .availableModels()
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, []);

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
