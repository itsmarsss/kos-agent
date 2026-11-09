/**
 * What a dropped gateway says in the log: one line when it goes down, one a
 * minute while it stays down, one when it is back.
 *
 * Every failed reconnect raised an error and every error was a line, so a
 * night without a network was about a hundred thousand lines of the same
 * ENOTFOUND, and the one line that mattered was nowhere to be found.
 */
export class DownLog {
  private downSince: number | undefined;
  private lastLine = 0;
  private quiet = 0;

  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
    private readonly everyMs = 60_000,
  ) {}

  /** Whether the last word was that the connection is down. */
  get down(): boolean {
    return this.downSince !== undefined;
  }

  /** An error from the gateway, or the socket closing. */
  error(what: string): void {
    const at = this.now();
    if (this.downSince === undefined) {
      this.downSince = at;
      this.lastLine = at;
      this.quiet = 0;
      this.log(`Discord: connection lost (${what})`);
      return;
    }
    if (at - this.lastLine < this.everyMs) {
      this.quiet += 1;
      return;
    }
    const more = this.quiet ? `, ${this.quiet} more like it` : "";
    this.lastLine = at;
    this.quiet = 0;
    this.log(`Discord: still down after ${Math.round((at - this.downSince) / 1000)}s (${what}${more})`);
  }

  /** The gateway is ready again, or resumed. */
  up(): void {
    if (this.downSince === undefined) return;
    const seconds = Math.round((this.now() - this.downSince) / 1000);
    this.downSince = undefined;
    this.quiet = 0;
    this.log(`Discord: connected again after ${seconds}s`);
  }
}
