import { useEffect } from "react";

/**
 * While `unsaved`, leaving the page (a reload, closing the tab, typing
 * another address) asks first, in the browser's own words: an edit not yet
 * saved was lost on a reload with nothing said. A move inside the dashboard
 * keeps the edit and is not asked about.
 */
export function useLeaveGuard(unsaved: boolean, win: Window = window): void {
  useEffect(() => {
    if (!unsaved) return;
    const ask = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      // Older engines ask only when a value is set.
      e.returnValue = "";
    };
    win.addEventListener("beforeunload", ask);
    return () => win.removeEventListener("beforeunload", ask);
  }, [unsaved, win]);
}
