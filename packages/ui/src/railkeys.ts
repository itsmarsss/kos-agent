import type { KeyboardEvent } from "react";

/**
 * The chat rail by keys. From its search, the down arrow steps into the list
 * and Enter opens the first chat that matches; in the list, the arrows walk
 * the rows (a chat, a project, KOS's own row) and the up arrow from the first
 * goes back to the search. Each row's ⋯ stays a Tab stop of its own.
 */
const ROW = "a.chats-item, a.chats-root";
const RAIL = ".chats-list";

function rowsOf(from: Element): HTMLElement[] {
  const rail = from.closest(RAIL);
  return rail ? [...rail.querySelectorAll<HTMLElement>(ROW)] : [];
}

export function railSearchKeys(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
  if (e.key === "ArrowDown") {
    const first = rowsOf(e.currentTarget)[0];
    if (!first) return;
    e.preventDefault();
    first.focus();
  } else if (e.key === "Enter" && e.currentTarget.value.trim() !== "") {
    // The first chat found, not KOS's own row, which the search leaves standing.
    const hit = rowsOf(e.currentTarget).find((r) => r.matches("a.chats-item"));
    if (!hit) return;
    e.preventDefault();
    hit.click();
  }
}

export function railRowKeys(e: KeyboardEvent<HTMLElement>): void {
  const at = e.target;
  if (!(at instanceof HTMLElement) || !at.matches(ROW) || e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = rowsOf(at);
  const i = rows.indexOf(at);
  const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)] ?? (e.key === "ArrowUp" ? at.closest(RAIL)?.querySelector<HTMLElement>(".chats-find input") : null);
  if (!next) return;
  e.preventDefault();
  next.focus();
}
