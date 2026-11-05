import type { PageRecord } from "./pages.js";

/** A page's figure for its project's card on Home. */
export type Headline = { label: string; value: unknown };

/**
 * Headlines, kept for a while.
 *
 * Listing pages ran every headline query on the spot, so one slow query held
 * the list, and with it Home. Now each is computed apart from the server
 * (through the page query runner, with its own deadline) and kept until the
 * page changes or it is `ttlMs` old. One that fails or runs out of time is
 * kept as nothing, so it is not retried on every list.
 */
export class Headlines {
  private readonly kept = new Map<string, { updatedAt: number; at: number; headline?: Headline }>();

  constructor(
    private readonly compute: (id: string) => Promise<Headline | undefined>,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async of(record: PageRecord): Promise<Headline | undefined> {
    const hit = this.kept.get(record.id);
    if (hit && hit.updatedAt === record.updatedAt && this.now() - hit.at < this.ttlMs) return hit.headline;
    const headline = await this.compute(record.id).catch(() => undefined);
    this.kept.set(record.id, { updatedAt: record.updatedAt, at: this.now(), headline });
    return headline;
  }
}
