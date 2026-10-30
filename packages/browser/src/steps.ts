/**
 * The gestures a run of browser steps is made of, checked before any runs.
 *
 * A target is a ref from the last look ("@e12") or a CSS selector. A step
 * is an object with exactly one key; anything else is refused with where it
 * went wrong, so a malformed run never half-happens.
 */

export type Step =
  | { open: string }
  | { go: "back" | "forward" | "reload" }
  | { click: string }
  | { hover: string }
  | { fill: { target: string; text: string } }
  | { type: { target: string; text: string } }
  | { press: string }
  | { select: { target: string; values: string[] } }
  | { check: string }
  | { uncheck: string }
  | { scroll: string }
  | { wait: number | { text: string } | { selector: string } | { gone: string } }
  | { dialog: { accept: boolean; text?: string } };

export const STEP_KEYS = ["open", "go", "click", "hover", "fill", "type", "press", "select", "check", "uncheck", "scroll", "wait", "dialog"] as const;

/** Steps that only look or move about: they run without asking. The rest act on the page. */
const READING_STEPS: ReadonlySet<string> = new Set(["open", "go", "hover", "scroll", "wait", "dialog"]);

/** The longest a step may wait. */
export const WAIT_MAX_MS = 30_000;

/**
 * Whether a run of steps does anything to the page. Decided on the raw
 * input, before the steps are parsed, so a shape the parser would refuse
 * counts as touching: an unreadable step never runs unasked.
 */
export function touchesPage(input: Record<string, unknown>): boolean {
  const steps = input["steps"];
  if (!Array.isArray(steps) || steps.length === 0) return true;
  return steps.some((s) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) return true;
    const keys = Object.keys(s as object);
    return keys.length !== 1 || !READING_STEPS.has(keys[0]!);
  });
}

/** One step, checked: exactly one known key with the right shape of value. */
export function parseStep(raw: unknown, at: number): Step {
  const where = `step ${at + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: must be an object with one of ${STEP_KEYS.join(", ")}`);
  const keys = Object.keys(raw as object);
  const key = keys.find((k) => (STEP_KEYS as readonly string[]).includes(k));
  if (!key || keys.length !== 1) throw new Error(`${where}: must have exactly one of ${STEP_KEYS.join(", ")}`);
  const value = (raw as Record<string, unknown>)[key];
  const str = (what: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${where}: ${key} wants ${what}`);
    return value.trim();
  };
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  // `selector` is the older name for a target, still taken.
  const target = (): string => {
    const t = record?.["target"] ?? record?.["selector"];
    if (typeof t !== "string" || !t.trim()) throw new Error(`${where}: ${key} wants {target, ...} with a @ref or CSS selector`);
    return t.trim();
  };
  switch (key) {
    case "open":
      return { open: str("a url") };
    case "go":
      if (value !== "back" && value !== "forward" && value !== "reload") throw new Error(`${where}: go wants "back", "forward" or "reload"`);
      return { go: value };
    case "click":
    case "hover":
    case "check":
    case "uncheck": {
      const t = str("a @ref or CSS selector");
      return { [key]: t } as Step;
    }
    case "fill":
    case "type": {
      const words = record?.["text"];
      if (typeof words !== "string") throw new Error(`${where}: ${key} wants {target, text}`);
      return { [key]: { target: target(), text: words } } as Step;
    }
    case "press":
      return { press: str("a key, like Enter or Meta+a") };
    case "select": {
      const many = Array.isArray(record?.["values"]) ? (record!["values"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const one = typeof record?.["value"] === "string" ? [record["value"] as string] : [];
      const values = [...many, ...one];
      if (values.length === 0) throw new Error(`${where}: select wants {target, values}`);
      return { select: { target: target(), values } };
    }
    case "scroll":
      return { scroll: str(`"up", "down", or a @ref to bring into view`) };
    case "wait": {
      if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0 || value > WAIT_MAX_MS) throw new Error(`${where}: wait wants milliseconds, up to ${WAIT_MAX_MS}`);
        return { wait: value };
      }
      for (const kind of ["text", "selector", "gone"] as const) {
        const v = record?.[kind];
        if (typeof v === "string" && v.trim()) return { wait: { [kind]: v.trim() } as { text: string } };
      }
      throw new Error(`${where}: wait wants milliseconds, {text}, {selector} or {gone}`);
    }
    case "dialog": {
      if (value === "accept" || value === "dismiss") return { dialog: { accept: value === "accept" } };
      if (record && typeof record["accept"] === "boolean") {
        return { dialog: { accept: record["accept"], ...(typeof record["text"] === "string" ? { text: record["text"] } : {}) } };
      }
      throw new Error(`${where}: dialog wants "accept", "dismiss" or {accept, text}`);
    }
    default:
      throw new Error(`${where}: unknown step`);
  }
}
