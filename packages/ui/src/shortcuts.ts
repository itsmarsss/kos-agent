/**
 * Every key the dashboard answers, by where it works: what the "?" sheet
 * lists. Only what exists: a key added to a page is added here, and a key
 * listed here that a page stops answering is a bug in one or the other.
 */
export interface Shortcut {
  keys: string;
  does: string;
}

export interface ShortcutGroup {
  where: string;
  keys: Shortcut[];
}

export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    where: "Anywhere",
    keys: [
      { keys: "⌘K", does: "Search everything, and > for commands (New project, New schedule, New claim, the theme)" },
      { keys: "⌘⇧K", does: "Quick ask, beside the open chat" },
      { keys: "⌘⇧B", does: "KOS's browser" },
      { keys: "/", does: "Search this page" },
      { keys: "?", does: "These keys" },
      { keys: "Esc", does: "Shut the menu or sheet on top" },
    ],
  },
  {
    where: "A chat's box",
    keys: [
      { keys: "↵", does: "Send" },
      { keys: "⇧↵", does: "A new line" },
      { keys: "⌘↵", does: "Stop the turn that is running" },
      { keys: "/  @", does: "Commands, and name things" },
    ],
  },
  {
    where: "The chat list",
    keys: [{ keys: "↓  ↑  ↵", does: "From its search, walk the chats and open one" }],
  },
  {
    where: "An approval",
    keys: [
      { keys: "↵", does: "Approve the ask you went to (never the next one on its own)" },
      { keys: "⌘⌫", does: "Deny it" },
    ],
  },
  {
    where: "Runs, Schedule and other lists",
    keys: [
      { keys: "↑  ↓  Home  End", does: "Move between rows" },
      { keys: "↵  Space", does: "Open the row" },
    ],
  },
  {
    where: "Memory, a claim",
    keys: [
      { keys: "P", does: "Pin or unpin" },
      { keys: "E", does: "Edit" },
      { keys: "Delete", does: "Forget, after you confirm" },
    ],
  },
  {
    where: "Files",
    keys: [
      { keys: "Space", does: "Quick Look" },
      { keys: "↵", does: "Rename" },
      { keys: "⌘↓  ⌘↑", does: "Open, and go up a folder" },
      { keys: "⌘D", does: "Duplicate" },
      { keys: "⌘⌫", does: "Move to the Trash" },
      { keys: "⌘I", does: "Info" },
      { keys: "⌘⇧N", does: "New folder" },
      { keys: "⌘1  ⌘2  ⌘3", does: "The views" },
      { keys: "Menu  ⇧F10", does: "The selection's menu" },
    ],
  },
  {
    where: "Menus and sheets",
    keys: [
      { keys: "↑  ↓  Home  End", does: "Walk a menu's rows" },
      { keys: "Tab", does: "Stays inside a sheet while it is open" },
      { keys: "↵", does: "In New project's or New schedule's name: create it" },
    ],
  },
];

/** A key pressed with nothing to type into, and no other key held: the page's own, not a field's. */
export function isLooseKey(e: KeyboardEvent): boolean {
  const t = e.target instanceof Element ? e.target : null;
  return !e.metaKey && !e.ctrlKey && !e.altKey && !t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}
