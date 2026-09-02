import type { Db } from "../store/db.js";

/**
 * Where a button press belongs.
 *
 * A button lives on a message that may sit in a channel for days, so the
 * mapping from "this button" to "the conversation that sent it" has to outlive
 * the process. It is a row rather than a map for that reason alone.
 *
 * The token is what travels on the wire, and it is a random name rather than
 * the conversation id: a custom id is visible to anyone who can read the
 * message, and the id of a conversation is not something to hand out.
 */

export interface PressRoute {
  token: string;
  /** Where the press is delivered, as a message. */
  conversationId: string;
  /** The agent's own name for the button. */
  buttonId: string;
  label: string;
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS button_routes (
  token TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  button_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

interface Row {
  token: string;
  conversation_id: string;
  button_id: string;
  label: string;
  created_at: number;
}

/** Long enough that guessing one is not a way in, short enough for a custom id. */
const TOKEN_BYTES = 12;

function newToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class PressRoutes {
  constructor(private readonly db: Db) {
    this.db.exec(SCHEMA);
  }

  /** Record where a button's press should land, and name it for the wire. */
  register(route: Omit<PressRoute, "token" | "createdAt">): string {
    const token = newToken();
    this.db
      .prepare(
        `INSERT INTO button_routes (token, conversation_id, button_id, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(token, route.conversationId, route.buttonId, route.label, Date.now());
    return token;
  }

  get(token: string): PressRoute | undefined {
    const row = this.db
      .prepare("SELECT * FROM button_routes WHERE token = ?")
      .get(token) as Row | undefined;
    if (!row) return undefined;
    return {
      token: row.token,
      conversationId: row.conversation_id,
      buttonId: row.button_id,
      label: row.label,
      createdAt: row.created_at,
    };
  }

  /**
   * Drop routes older than a cutoff.
   *
   * Buttons are not deleted when the message they are on scrolls away, so
   * without this the table only ever grows. A press on a route that has been
   * swept is refused rather than delivered somewhere stale.
   */
  prune(olderThanMs: number): number {
    const result = this.db
      .prepare("DELETE FROM button_routes WHERE created_at < ?")
      .run(Date.now() - olderThanMs);
    return Number(result.changes ?? 0);
  }
}
