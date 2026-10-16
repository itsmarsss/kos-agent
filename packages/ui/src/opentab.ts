import { createContext, useContext } from "react";

/**
 * How anything on the page shows a browser tab: a chip in a chat, a button
 * in Settings. The window lives at the top of the app, so the way to it is
 * handed down rather than imported.
 */
export const OpenTab = createContext<((tab: string) => void) | null>(null);

export function useOpenTab(): ((tab: string) => void) | null {
  return useContext(OpenTab);
}
