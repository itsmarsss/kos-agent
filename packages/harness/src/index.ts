/**
 * @kos/harness
 *
 * The operational core of KOS: store, jail, agent loop, model router, tools,
 * cron, memory, and the operational spine. Built out across the KOS.md build
 * order.
 */

import { KOS_VERSION } from "@kos/shared";

export { JailError, resolvePath } from "./jail/index.js";
export { Workspace, openDatabase, DB_FILENAME, type Db } from "./store/index.js";
export { SecretsRegistry } from "./secrets/index.js";
export * from "./models/index.js";
export * from "./agent/index.js";
export * from "./channels/index.js";

export function version(): string {
  return KOS_VERSION;
}
