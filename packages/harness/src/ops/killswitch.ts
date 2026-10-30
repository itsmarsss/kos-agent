import type { Db } from "../store/db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kill_switch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  halted INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * The global kill switch: one flag that halts all crons and self-prompts.
 * Persisted in a single row so a halt survives a restart. Exposes a `halted`
 * getter, so it satisfies the scheduler's KillSwitch interface directly.
 */
export class PersistentKillSwitch {
  private readonly listeners = new Set<(halted: boolean) => void>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO kill_switch (id, halted, updated_at) VALUES (1, 0, ?)`,
      )
      .run(this.now());
  }

  get halted(): boolean {
    const row = this.db
      .prepare(`SELECT halted FROM kill_switch WHERE id = 1`)
      .get() as { halted: number } | undefined;
    return row?.halted === 1;
  }

  halt(): void {
    this.set(true);
  }

  resume(): void {
    this.set(false);
  }

  /** Told when this process flips the switch; a flip from another process is seen by reading `halted`. */
  onChange(listener: (halted: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(halted: boolean): void {
    const was = this.halted;
    this.db
      .prepare(`UPDATE kill_switch SET halted = ?, updated_at = ? WHERE id = 1`)
      .run(halted ? 1 : 0, this.now());
    if (was !== halted) for (const listener of this.listeners) listener(halted);
  }
}
