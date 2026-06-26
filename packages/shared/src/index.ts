/**
 * @kos/shared
 *
 * Types and contracts shared across the harness and UI: the skill contract,
 * the page-spec schema, and other cross-package primitives. Both sides import
 * from here so the contract has a single source of truth.
 */

export const KOS_VERSION = "0.0.0";

export {
  capabilityKey,
  type CapabilityKind,
  type CapabilityRef,
  type ModuleManifest,
  type NeededCapability,
  type ProvidedCapability,
} from "./module.js";
