/**
 * What a tool's own name says about Auto mode, for tools KOS did not write
 * (an MCP server's): one named for spending money or deleting reaches past
 * the workspace in a way Auto never covers, so it asks as in Ask. Read from
 * the name alone, deterministically, as every other risk rule is.
 */

const PAYS = /(^|[^a-z])(pay|payment|purchase|checkout|charge|buy|transfer|refund)(?![a-z])/;
const DELETES = /(^|[^a-z])(delete|remove|destroy|drop|purge|trash|erase|wipe|unlink|rm)(?![a-z])/;

/** Why Auto does not cover a tool by this name, or false. */
export function beyondAutoByName(name: string): string | false {
  // Words split where camelCase joins them: removeLabel reads as remove_label.
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (PAYS.test(words)) return "may spend money";
  if (DELETES.test(words)) return "may delete something outside the workspace";
  return false;
}
