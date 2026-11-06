import { caller, turn } from "./caller.js";

/**
 * Projects a running turn created, which that turn alone may build and fill.
 *
 * The chat that made a project used to keep its reach for good, through a
 * column on the manifest: any later turn there, a guest's included, could
 * write a project that was never its own. Now the reach is held in memory,
 * keyed by conversation and turn, opened only for a turn that may have it,
 * and dropped when the turn ends. A later turn hands the work to the
 * project's own chat.
 */
export class TurnMade {
  private readonly open = new Map<string, Set<string>>();

  /** Open a turn's record: only a turn that may build what it makes gets one. */
  begin(conversationId: string, turnId: string): void {
    this.open.set(keyOf(conversationId, turnId), new Set());
  }

  end(conversationId: string, turnId: string): void {
    this.open.delete(keyOf(conversationId, turnId));
  }

  /** The calling turn made this project; ignored for a turn with no record. */
  note(slug: string): void {
    this.current()?.add(slug);
  }

  /** The projects the calling turn made. */
  made(): string[] {
    return [...(this.current() ?? [])];
  }

  private current(): Set<string> | undefined {
    const conversationId = caller.getStore();
    const turnId = turn.getStore();
    return conversationId && turnId ? this.open.get(keyOf(conversationId, turnId)) : undefined;
  }
}

function keyOf(conversationId: string, turnId: string): string {
  return `${conversationId}\u0000${turnId}`;
}
