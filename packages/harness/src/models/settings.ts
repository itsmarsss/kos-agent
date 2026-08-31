import type { Effort } from "./provider.js";
import type { ModelRouter, Task } from "./router.js";

/**
 * The owner's model choices, as stored and as edited in the dashboard.
 *
 * One entry per task class, because that is the unit the router dispatches on:
 * "reasoning" is every real turn, "cheap" is the salience pass. Each field is
 * optional so a setting can override the model without also pinning an effort
 * the provider might reject.
 */

export const MODEL_SETTINGS_KEY = "models";

export interface TaskModelSetting {
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

export type ModelSettings = Partial<Record<Task, TaskModelSetting>>;

export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const TASKS: Task[] = ["reasoning", "cheap"];

/** Reject anything that is not a setting we can act on, field by field. */
export function parseModelSettings(raw: unknown): ModelSettings {
  if (typeof raw !== "object" || raw === null) return {};
  const input = raw as Record<string, unknown>;
  const out: ModelSettings = {};

  for (const task of TASKS) {
    const entry = input[task];
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const setting: TaskModelSetting = {};

    if (typeof e["model"] === "string" && e["model"].trim() !== "") {
      setting.model = e["model"].trim();
    }
    if (typeof e["effort"] === "string" && EFFORTS.includes(e["effort"] as Effort)) {
      setting.effort = e["effort"] as Effort;
    }
    const max = e["maxTokens"];
    if (typeof max === "number" && Number.isInteger(max) && max > 0) {
      setting.maxTokens = max;
    }
    if (Object.keys(setting).length > 0) out[task] = setting;
  }
  return out;
}

/**
 * Point the router at whatever the owner chose, leaving the provider and any
 * field they did not set as they were. An empty setting is a no-op rather than
 * a reset, so clearing one field cannot silently clear the others.
 */
export function applyModelSettings(
  router: ModelRouter,
  settings: ModelSettings | undefined,
): void {
  if (!settings) return;
  for (const task of TASKS) {
    const setting = settings[task];
    if (!setting) continue;
    const current = router.routeFor(task);
    router.setRoute(task, {
      provider: current.provider,
      spec: {
        ...current.spec,
        ...(setting.model ? { model: setting.model } : {}),
        ...(setting.effort ? { effort: setting.effort } : {}),
        ...(setting.maxTokens ? { maxTokens: setting.maxTokens } : {}),
      },
    });
  }
}
