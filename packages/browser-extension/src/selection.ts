/**
 * What the owner selects on a page, for the side panel beside it: the
 * selection, as it settles, told to the extension, which hands it to a panel
 * open in that window and to nothing else. Put in each page where the owner
 * has let KOS read pages; it reads nothing but the selection, and only as
 * the owner makes it. Stands alone: it runs in the page, not the extension.
 */
const SETTLE_MS = 250;
const MAX = 4_000;

const w = window as unknown as { __kosSelection?: boolean };
if (!w.__kosSelection) {
  w.__kosSelection = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = String(getSelection() ?? "").replace(/\s+\n/g, "\n").trim().slice(0, MAX);
      if (text === last) return;
      last = text;
      // The extension may have been reloaded under the page: nothing to tell then.
      void chrome.runtime.sendMessage({ type: "selection", text }).catch(() => undefined);
    }, SETTLE_MS);
  });
}
