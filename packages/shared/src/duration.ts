/**
 * How long a step took, as its card says it: "420ms", "2.4s", "12s",
 * "1m 04s", "1h 04m". A live count says whole seconds, so it does not
 * flicker through tenths: "3s", "1m 04s".
 */
export function formatDuration(ms: number, live = false): string {
  const t = Math.max(0, ms);
  if (!live && t < 1_000) return `${Math.round(t)}ms`;
  if (!live && t < 9_950) return `${(t / 1_000).toFixed(1)}s`;
  const seconds = Math.floor(t / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long a step waited on the owner's yes, in a word or two: "waited 40s for you", "waited 2m for you". */
export function waitWords(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1_000);
  if (seconds < 60) return `waited ${seconds}s for you`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `waited ${minutes}m for you`;
  return `waited ${Math.floor(minutes / 60)}h ${minutes % 60}m for you`;
}
