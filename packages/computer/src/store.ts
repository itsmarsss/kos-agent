import { randomBytes } from "node:crypto";

import type { Db } from "@kos/harness";

/**
 * The devices the owner has paired: who each is and the key it proves
 * itself with. Whether one is online is the hub's business and does not
 * survive a restart; this is the part that must.
 *
 * A trust table: the kernel's sql fence never lets a model write it, since
 * a row here decides which computers KOS will drive.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS device_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * The owner's rules for computer use on the KOS side. The device keeps its
 * own (how long a session may last, whether it asks), and wins: these only
 * say what KOS asks for, and whether work nobody started may ask at all.
 * A trust table too, since `unattended` lets a schedule reach a computer.
 */
export interface ComputerSettings {
  /** How long KOS asks for when a chat does not say. */
  askMinutes: number;
  /** Whether a schedule, a blob's own timer or a guest's message may start a session. */
  unattended: boolean;
}

export const DEFAULT_SETTINGS: ComputerSettings = { askMinutes: 15, unattended: false };
export const MAX_ASK_MINUTES = 480;

export interface Device {
  id: string;
  name: string;
  platform: string;
  publicKey: string;
  pairedAt: number;
  lastSeen: number | null;
}

interface Row {
  id: string;
  name: string;
  platform: string;
  public_key: string;
  paired_at: number;
  last_seen: number | null;
}

const toDevice = (r: Row): Device => ({
  id: r.id,
  name: r.name,
  platform: r.platform,
  publicKey: r.public_key,
  pairedAt: r.paired_at,
  lastSeen: r.last_seen,
});

/** A device's name, as given: trimmed, one line, and short enough for a menu. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 60);
}

export class DeviceStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  add(input: { name: string; platform: string; publicKey: string }): Device {
    const id = `dev_${randomBytes(9).toString("base64url")}`;
    const name = this.unique(cleanName(input.name) || "Computer");
    this.db
      .prepare(`INSERT INTO devices (id, name, platform, public_key, paired_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name, input.platform.slice(0, 20), input.publicKey, this.now());
    return this.get(id)!;
  }

  /** A name no other device has: "Studio MacBook", then "Studio MacBook 2", so the owner can say which. */
  private unique(name: string): string {
    const taken = new Set(this.list().map((d) => d.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let n = 2;
    while (taken.has(`${name} ${n}`.toLowerCase())) n++;
    return `${name} ${n}`;
  }

  get(id: string): Device | undefined {
    const row = this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as Row | undefined;
    return row ? toDevice(row) : undefined;
  }

  byKey(publicKey: string): Device | undefined {
    const row = this.db.prepare(`SELECT * FROM devices WHERE public_key = ?`).get(publicKey) as Row | undefined;
    return row ? toDevice(row) : undefined;
  }

  list(): Device[] {
    return (this.db.prepare(`SELECT * FROM devices ORDER BY paired_at`).all() as Row[]).map(toDevice);
  }

  rename(id: string, name: string): Device | undefined {
    const clean = cleanName(name);
    if (!clean) throw new Error("a device needs a name");
    this.db.prepare(`UPDATE devices SET name = ? WHERE id = ?`).run(clean, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM devices WHERE id = ?`).run(id).changes > 0;
  }

  seen(id: string): void {
    this.db.prepare(`UPDATE devices SET last_seen = ? WHERE id = ?`).run(this.now(), id);
  }

  settings(): ComputerSettings {
    const rows = this.db.prepare(`SELECT key, value FROM device_settings`).all() as { key: string; value: string }[];
    const saved = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const minutes = Number(saved.askMinutes);
    return {
      askMinutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_ASK_MINUTES ? minutes : DEFAULT_SETTINGS.askMinutes,
      unattended: saved.unattended === "true",
    };
  }

  /** Change some of the settings; anything out of range is refused, not clamped. */
  setSettings(patch: Partial<ComputerSettings>): ComputerSettings {
    if (patch.askMinutes !== undefined && !(Number.isInteger(patch.askMinutes) && patch.askMinutes >= 1 && patch.askMinutes <= MAX_ASK_MINUTES)) {
      throw new Error(`askMinutes is a whole number of minutes from 1 to ${MAX_ASK_MINUTES}`);
    }
    const put = this.db.prepare(`INSERT INTO device_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    if (patch.askMinutes !== undefined) put.run("askMinutes", String(patch.askMinutes));
    if (patch.unattended !== undefined) put.run("unattended", String(patch.unattended));
    return this.settings();
  }
}
