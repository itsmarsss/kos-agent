import type { ReactElement } from "react";

import { BlockActions, Markdown } from "@kos/kit";

/**
 * A message's words in the thread. Only KOS's own offer a typed block's
 * Send: a block the owner pasted, a guest's or a note's is drawn the same
 * way but can only be copied.
 */
export function ChatWords({ role, text, actions }: { role: string; text: string; actions: BlockActions }): ReactElement {
  if (role !== "kos") return <Markdown text={text} />;
  return (
    <BlockActions.Provider value={actions}>
      <Markdown text={text} />
    </BlockActions.Provider>
  );
}
