/**
 * @kos/ui
 *
 * The fixed React shell, widget library, and page-spec renderer. The agent
 * authors pages as JSON specs; this package renders them from a fixed set of
 * widgets behind per-page and per-widget error boundaries. Built at the UI
 * step of the KOS.md build order.
 */

import { KOS_VERSION } from "@kos/shared";

export function version(): string {
  return KOS_VERSION;
}
