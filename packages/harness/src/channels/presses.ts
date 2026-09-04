import type { Db } from "../store/db.js";
import type { ModalSpec } from "./types.js";

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
  /**
   * The form this button opens, if it opens one.
   *
   * Stored rather than kept in memory because the surface does not hand the
   * form back on a press: it hands back the button, and the button may be
   * days older than the process.
   */
  modal?: ModalSpec;
  /** The answer to this press is only for whoever pressed it. */
  ephemeral?: boolean;
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

/** Added after the table existed, so a workspace that predates them still opens. */
const COLUMNS: [string, string][] = [
  ["modal", "TEXT"],
  ["ephemeral", "INTEGER NOT NULL DEFAULT 0"],
];

interface Row {
  token: string;
  conversation_id: string;
  button_id: string;
  label: string;
  modal: string | null;
  ephemeral: number | null;
  created_at: number;
}

function parseModal(raw: string | null): ModalSpec | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ModalSpec;
    return Array.isArray(parsed.fields) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    for (const [name, type] of COLUMNS) {
      try {
        this.db.exec(`ALTER TABLE button_routes ADD COLUMN ${name} ${type}`);
      } catch {
        // Already there, which is the ordinary case after the first run.
      }
    }
  }

  /** Record where a button's press should land, and name it for the wire. */
  register(route: Omit<PressRoute, "token" | "createdAt">): string {
    const token = newToken();
    this.db
      .prepare(
        `INSERT INTO button_routes
           (token, conversation_id, button_id, label, modal, ephemeral, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token,
        route.conversationId,
        route.buttonId,
        route.label,
        route.modal ? JSON.stringify(route.modal) : null,
        route.ephemeral ? 1 : 0,
        Date.now(),
      );
    return token;
  }

  get(token: string): PressRoute | undefined {
    const row = this.db
      .prepare("SELECT * FROM button_routes WHERE token = ?")
      .get(token) as Row | undefined;
    if (!row) return undefined;
    const modal = parseModal(row.modal);
    return {
      token: row.token,
      conversationId: row.conversation_id,
      buttonId: row.button_id,
      label: row.label,
      ...(modal ? { modal } : {}),
      ...(row.ephemeral ? { ephemeral: true } : {}),
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
