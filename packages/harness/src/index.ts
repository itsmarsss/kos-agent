/**
 * @kos/harness
 *
 * The operational core of KOS: store, jail, agent loop, model router, tools,
 * cron, memory, and the operational spine. Built out across the KOS.md build
 * order. This entry point will wire and boot the harness.
 */

import { KOS_VERSION } from "@kos/shared";

export function version(): string {
  return KOS_VERSION;
}
