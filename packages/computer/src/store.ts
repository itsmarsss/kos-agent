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
`;

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
}
