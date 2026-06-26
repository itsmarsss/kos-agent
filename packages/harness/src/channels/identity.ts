/**
 * Maps a channel-native sender to a KOS user. This is the seam multi-user plugs
 * into later (a SQLite sender->user table). For now it is stubbed to a single
 * owner so the core never hardcodes the owner's identity inline.
 */
export interface UserMapping {
  resolve(channel: string, senderId: string): string;
}

export const DEFAULT_OWNER_ID = "owner";

export class SingleOwnerMapping implements UserMapping {
  constructor(private readonly ownerId: string = DEFAULT_OWNER_ID) {}

  resolve(_channel: string, _senderId: string): string {
    return this.ownerId;
  }
}
