import { ASK, type ChatMode } from "@kos/shared";
import { useEffect, useState } from "react";

import { api, type Conversation } from "./api.js";

/**
 * The chat's mode as the composer shows it: what the list says (only a chat
 * in Auto carries one), or what the owner just chose until the list catches
 * up. Setting it goes to KOS, which tells every other surface showing the chat.
 */
export function useChatMode(chat: Conversation | undefined, onChanged: () => void): [ChatMode, (mode: ChatMode) => void] {
  const [chosen, setChosen] = useState<{ id: string; mode: ChatMode } | null>(null);
  const listed = chat?.mode ?? ASK;
  // The list has read again since: it holds the truth, whichever surface set it.
  useEffect(() => setChosen(null), [chat?.mode?.mode, chat?.mode?.until, chat?.mode?.sessions]);
  const set = (mode: ChatMode): void => {
    if (!chat) return;
    setChosen({ id: chat.id, mode });
    void api.setChatMode(chat.id, mode).then(onChanged, () => setChosen(null));
  };
  return [chosen && chosen.id === chat?.id ? chosen.mode : listed, set];
}
