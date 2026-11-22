import { useEffect, useState, type ReactElement } from "react";

import { api } from "./api.js";
import { hrefFor } from "./routes.js";
import { Select } from "./Select.js";

/**
 * The model for thinking, beside the send button: swapped here for the next
 * message, and the way into Settings, Models for the rest (the cheap and the
 * screen model, the provider). A chip that showed a name with only a tooltip
 * left the owner with no idea where a model is changed.
 */

/** The menu's last item, which opens Settings, Models rather than picking a model. */
export const MORE_MODELS = "__settings";

/** Where the chip sends the owner for every model setting. */
export const MODELS_HREF = hrefFor({ name: "settings", section: "models" });

function openModels(): void {
  window.location.hash = MODELS_HREF;
}

export function ModelPicker(): ReactElement | null {
  const [models, setModels] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>("");
  /** Read once: until then there is nothing true to show. */
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<"api" | "sdk">("api");

  useEffect(() => {
    void api
      .modelSettings()
      .then((s) => setCurrent(s.routes?.["reasoning"]?.model ?? ""))
      .catch(() => undefined)
      .finally(() => setRead(true));
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
   * On the subscription the model is Claude Code's to choose, and this
   * control writes the provider routing, which that path does not read. So
   * the chip says who answers and opens Settings, where that is changed.
   */
  if (!read) return null;
  if (engine === "sdk" || !current) {
    return (
      <a className="composer-engine" href={MODELS_HREF} title="Change the model in Settings, Models">
        {engine === "sdk" ? "Claude Code" : "Pick a model"}
      </a>
    );
  }

  const choices = models.includes(current) ? models : [current, ...models];

  return (
    <Select
      className="composer-model"
      label="The model for thinking"
      value={current}
      disabled={busy}
      options={[
        ...choices.map((m) => ({ value: m, label: m })),
        { value: MORE_MODELS, label: "All model settings…", hint: "the cheap and screen models, the provider" },
      ]}
      onChange={(model) => {
        if (model === MORE_MODELS) {
          openModels();
          return;
        }
        setCurrent(model);
        setBusy(true);
        void api
          .saveModelSettings({ reasoning: { model } })
          .finally(() => setBusy(false));
      }}
    />
  );
}
