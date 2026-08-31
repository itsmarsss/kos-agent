import type { MutationTarget, PageSpec, Widget, WidgetType } from "./pagespec.js";

/**
 * Page-spec validation, run at write time so malformed pages are flagged before
 * render. Returns a list of human-readable errors (empty means valid). This is
 * the schema-check fail-safe layer: a bad page is bad data, not a crash.
 */

const WIDGET_TYPES: WidgetType[] = [
  "stat",
  "table",
  "chart",
  "list",
  "markdown",
  "card",
  "form",
  "custom_html",
];

const CHART_KINDS = ["line", "bar", "area", "pie"];
const QUERY_WIDGETS: WidgetType[] = ["stat", "table", "chart", "list", "card"];
const ID_RE = /^[a-z][a-z0-9_-]*$/i;
const SPANS = ["quarter", "third", "half", "full"];

/** A statement is read-only if it is a single SELECT/WITH with no write verbs. */
export function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) return false; // no multiple statements
  if (!/^\s*(select|with)\b/i.test(trimmed)) return false;
  return !/\b(insert|update|delete|drop|alter|create|replace|attach|pragma|truncate)\b/i.test(
    trimmed,
  );
}

function validateMutation(
  m: MutationTarget,
  where: string,
  errors: string[],
): void {
  if (!m.table || typeof m.table !== "string") {
    errors.push(`${where}: mutation target requires a table`);
  }
  if (!Array.isArray(m.columns) || m.columns.length === 0) {
    errors.push(`${where}: mutation target requires at least one column`);
  }
}

function validateWidget(widget: Widget, index: number, errors: string[]): void {
  const where = `widget[${index}]`;
  if (!WIDGET_TYPES.includes(widget.type)) {
    errors.push(`${where}: unknown widget type "${widget.type}"`);
    return;
  }
  if (widget.span !== undefined && !SPANS.includes(widget.span)) {
    errors.push(`${where}: span must be one of ${SPANS.join(", ")}`);
  }

  if (QUERY_WIDGETS.includes(widget.type)) {
    const q = (widget as { query?: unknown }).query;
    if (typeof q !== "string" || q.trim() === "") {
      errors.push(`${where}: ${widget.type} requires a query`);
    } else if (!isReadOnlyQuery(q)) {
      errors.push(`${where}: display query must be read-only`);
    }
  }

  if (widget.type === "stat" && !widget.label) {
    errors.push(`${where}: stat requires a label`);
  }
  if (widget.type === "chart" && !CHART_KINDS.includes(widget.kind)) {
    errors.push(`${where}: chart requires a valid kind`);
  }
  if (widget.type === "markdown" && typeof widget.content !== "string") {
    errors.push(`${where}: markdown requires content`);
  }
  if (widget.type === "custom_html") {
    if (typeof widget.html !== "string") {
      errors.push(`${where}: custom_html requires html`);
    }
    if (
      widget.height !== undefined &&
      (typeof widget.height !== "number" || !Number.isFinite(widget.height))
    ) {
      errors.push(`${where}: custom_html height must be a number`);
    }
  }
  if (widget.type === "form") {
    if (!widget.mutate) errors.push(`${where}: form requires a mutation target`);
    else validateMutation(widget.mutate, where, errors);
  }
  if ((widget.type === "list" || widget.type === "card") && widget.mutate) {
    validateMutation(widget.mutate, where, errors);
  }
}

export function validatePageSpec(spec: PageSpec): string[] {
  const errors: string[] = [];

  if (!spec || typeof spec !== "object") {
    return ["page spec must be an object"];
  }
  if (!spec.id || !ID_RE.test(spec.id)) {
    errors.push("page id must match ^[a-z][a-z0-9_-]*$");
  }
  if (!spec.title || typeof spec.title !== "string") {
    errors.push("page requires a title");
  }
  if (!Array.isArray(spec.widgets)) {
    errors.push("page requires a widgets array");
    return errors;
  }

  const seenIds = new Set<string>();
  spec.widgets.forEach((widget, i) => {
    if (widget.id) {
      if (seenIds.has(widget.id)) {
        errors.push(`widget[${i}]: duplicate widget id "${widget.id}"`);
      }
      seenIds.add(widget.id);
    }
    validateWidget(widget, i, errors);
  });

  return errors;
}

export function isValidPageSpec(spec: PageSpec): boolean {
  return validatePageSpec(spec).length === 0;
}
