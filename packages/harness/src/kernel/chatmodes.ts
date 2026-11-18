import { ASK, liveMode, parseChatMode, type ChatMode } from "@kos/shared";

import type { SettingsStore } from "../store/settings.js";

/** Each chat's mode, by conversation id; a chat with none is in Ask. */
export const CHAT_MODES_KEY = "chat.modes";
/** The chats that acted in the owner's Chrome without asking, before modes: read once, then gone. */
export const ACTS_ALONE_KEY = "browser.actsAlone";

/**
 * The mode each chat is in, kept in the owner's settings and held here, since
 * every risky call reads it and only this writes it.
 *
 * Only Auto is stored: Ask is the absence of one, so a chat deleted or never
 * touched costs nothing. Auto that has run out reads as Ask and is dropped
 * the next time it is read.
 */
export class ChatModes {
  private modes: Record<string, ChatMode>;
  /** The chats that acted alone in the owner's Chrome before modes, set back to Ask at this boot: the owner is told once. */
  readonly migrated: string[];

  constructor(
    private readonly settings: Pick<SettingsStore, "get" | "set" | "delete">,
    private readonly now: () => number = Date.now,
    /** The kill switch as the store has it: thrown, every chat is back in Ask, at boot or whoever threw it. */
    private readonly halted: () => boolean = () => false,
  ) {
    this.modes = this.read();
    this.migrated = this.migrate();
    if (this.halted()) this.clear();
  }

  /** A chat's mode as it stands now. */
  of(conversationId: string): ChatMode {
    if (this.halted()) {
      this.clear();
      return ASK;
    }
    const kept = this.modes[conversationId];
    const live = liveMode(kept, this.now());
    if (kept && live === ASK) this.set(conversationId, ASK);
    return live;
  }

  /** Set a chat's mode; Ask forgets it. */
  set(conversationId: string, mode: ChatMode): void {
    const { [conversationId]: _was, ...others } = this.modes;
    this.modes = mode.mode === "auto" ? { ...others, [conversationId]: mode } : others;
    this.settings.set(CHAT_MODES_KEY, this.modes);
  }

  /** A turn in the chat finished: Auto set for "this task" ends with it. */
  taskEnded(conversationId: string): boolean {
    if (this.modes[conversationId]?.until !== "task") return false;
    this.set(conversationId, ASK);
    return true;
  }

  /** Every chat back to Ask, as the kill switch does: the chats that were in Auto. */
  clear(): string[] {
    const were = Object.keys(this.modes);
    if (were.length) {
      this.modes = {};
      this.settings.set(CHAT_MODES_KEY, this.modes);
    }
    return were;
  }

  /** The chats in Auto now, by id. */
  autoChats(): string[] {
    if (this.halted()) this.clear();
    const now = this.now();
    return Object.entries(this.modes)
      .filter(([, mode]) => liveMode(mode, now).mode === "auto")
      .map(([id]) => id);
  }

  private read(): Record<string, ChatMode> {
    const saved = this.settings.get<Record<string, unknown>>(CHAT_MODES_KEY);
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return {};
    const modes: Record<string, ChatMode> = {};
    for (const [id, raw] of Object.entries(saved)) {
      const mode = parseChatMode(raw);
      if (mode?.mode === "auto") modes[id] = mode;
    }
    return modes;
  }

  /**
   * A chat that acted alone in the owner's Chrome starts in Ask. Auto covers
   * far more of a chat than that setting did, so it is never widened into
   * silently: the owner turns Auto on per chat. The ids are told once.
   */
  private migrate(): string[] {
    const old = this.settings.get<unknown>(ACTS_ALONE_KEY);
    if (old === undefined) return [];
    this.settings.delete(ACTS_ALONE_KEY);
    return Array.isArray(old) ? old.filter((id): id is string => typeof id === "string") : [];
  }
}
