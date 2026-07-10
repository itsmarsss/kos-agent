/**
 * @deprecated Use `kos start` / `kos discord` (host). Kept as a thin re-export
 * surface if external code imported runDiscord; the CLI routes to runHost.
 */

export interface DiscordOptions {
  rootDir: string;
  allowedHosts: string[];
}

/** @deprecated Prefer kos start (multi-modal host). */
export async function runDiscord(_options: DiscordOptions): Promise<void> {
  throw new Error(
    "runDiscord is retired; use `kos start` or `kos discord` (multi-modal host)",
  );
}
