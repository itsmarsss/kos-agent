/** What a toast says of a decision: what was decided, by what it asked, and whether the chat still waits on another. */
export function decidedWords(approved: boolean, what: string, how: { remember: boolean; kept: boolean; held: boolean }): string {
  const said = `${approved ? "Approved" : "Denied"}: ${what}`;
  const kept = approved && how.remember ? (how.kept ? ", and remembered" : "; nothing to remember for this one") : "";
  return `${said}${kept}${how.held ? ". The chat waits on another ask" : ""}`;
}
