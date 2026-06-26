/**
 * Module contracts. KOS is a typed plugin system: the kernel (loader, jail,
 * store, router, agent loop) loads modules, and everything else (tools,
 * widgets, channel adapters, model/embedding providers, skills, first-party
 * features) is a module. These are the pure data shapes a module's `module.json`
 * declares. Runtime contracts (the loader, the activation context) live in the
 * harness kernel.
 */

export type CapabilityKind =
  | "tool"
  | "widget"
  | "channel"
  | "model-provider"
  | "embedding-provider"
  | "skill";

export interface CapabilityRef {
  kind: CapabilityKind;
  name: string;
}

export interface ProvidedCapability extends CapabilityRef {
  version: string;
}

export interface NeededCapability extends CapabilityRef {
  /** Version range the dependency must satisfy: "*", exact, "^x.y.z", ">=x.y.z". */
  range: string;
}

/**
 * A module's declared identity and contract. Mirrors `module.json`: what it
 * provides, what it needs, the secrets it references by name, and its risk tier.
 */
export interface ModuleManifest {
  name: string;
  version: string;
  provides: ProvidedCapability[];
  needs?: NeededCapability[];
  /** Secret names (never values) the module references. */
  secrets?: string[];
  riskTier?: "safe" | "risky";
}

export function capabilityKey(ref: CapabilityRef): string {
  return `${ref.kind}:${ref.name}`;
}
