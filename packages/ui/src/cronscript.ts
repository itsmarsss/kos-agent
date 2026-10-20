/**
 * The script a fixed-calls job runs, read from and written into its actions.
 *
 * A job that runs a promoted script skill is one skills.run call, and the
 * editor offers that as a pick rather than JSON to type: the pick reads
 * the first skills.run in the list and rewrites it, leaving every other
 * call (the notify after it, say) where it was.
 */

interface Action {
  tool: string;
  args: Record<string, unknown>;
}

function parse(actions: string): Action[] | null {
  try {
    const parsed: unknown = JSON.parse(actions);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((a): a is Action => typeof a === "object" && a !== null && typeof (a as Action).tool === "string").map((a) => ({ tool: a.tool, args: typeof a.args === "object" && a.args !== null ? (a.args as Record<string, unknown>) : {} }));
  } catch {
    return null;
  }
}

/** The script the first skills.run call names, or "" when the job runs none. */
export function scriptIn(actions: string): string {
  const run = parse(actions)?.find((a) => a.tool === "skills.run");
  return run && typeof run.args["name"] === "string" ? run.args["name"] : "";
}

/** The actions with the first skills.run call naming this script, put first when there was none; "" takes it out. */
export function withScript(actions: string, name: string): string {
  const list = parse(actions) ?? [];
  const at = list.findIndex((a) => a.tool === "skills.run");
  const next = name
    ? at >= 0
      ? list.map((a, i) => (i === at ? { ...a, args: { ...a.args, name } } : a))
      : [{ tool: "skills.run", args: { name } }, ...list]
    : list.filter((_, i) => i !== at);
  return JSON.stringify(next, null, 2);
}
