/**
 * What the owner selects on a page, for the side panel beside it: the
 * selection, as it settles, told to the extension, which hands it to a panel
 * open in that window and to nothing else. Put in each page where the owner
 * has let KOS read pages; it reads nothing but the selection, and only as
 * the owner makes it. Put in again (a panel opening beside the page), it
 * says what is selected now. Stands alone: it runs in the page, not the
 * extension.
 */
const SETTLE_MS = 250;
const MAX = 4_000;

const w = window as unknown as { __kosSelection?: () => void };
if (w.__kosSelection) {
  w.__kosSelection();
} else {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  const current = (): string => String(getSelection() ?? "").replace(/\s+\n/g, "\n").trim().slice(0, MAX);
  // The extension may have been reloaded under the page: nothing to tell then.
  const tell = (text: string): void => void chrome.runtime.sendMessage({ type: "selection", text }).catch(() => undefined);
  // Asked again, only a frame holding a selection answers: an empty one would
  // stand over the frame where the owner did select.
  w.__kosSelection = () => {
    last = current();
    if (last) tell(last);
  };
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = current();
      if (text === last) return;
      last = text;
      tell(text);
    }, SETTLE_MS);
  });
}
