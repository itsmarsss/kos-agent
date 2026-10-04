/**
 * @kos/harness
 *
 * The operational core of KOS: store, jail, agent loop, model router, tools,
 * cron, memory, and the operational spine. Built out across the KOS.md build
 * order.
 */

import { KOS_VERSION } from "@kos/shared";

export * from "./modules/index.js";
export { JailError, resolvePath } from "./jail/index.js";
export { Workspace, openDatabase, DB_FILENAME, type Db } from "./store/index.js";
export { SecretsRegistry } from "./secrets/index.js";
export * from "./models/index.js";
export * from "./risk/index.js";
export * from "./agent/index.js";
export * from "./channels/index.js";
export * from "./sandbox/index.js";
export * from "./memory/index.js";
export * from "./systems/index.js";
export * from "./cron/index.js";
export * from "./daemons/index.js";
export * from "./ops/index.js";
export * from "./tools/index.js";
export * from "./widgets/index.js";
export * from "./skills/index.js";
export * from "./kernel/index.js";

export function version(): string {
  return KOS_VERSION;
}
export {
  listSites,
  listSitesFor,
  resolveSiteRequest,
  startSiteServer,
  sitesDirFor,
} from "./sites/server.js";
export type { Site } from "./sites/server.js";
export { createDefaultRouter } from "./models/router.js";
