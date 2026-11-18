import type { KeyPlatform } from "@kos/shared";

/**
 * Whose keyboard an ask's keys are said for on a surface the host writes
 * for (Discord, iMessage, a device's card): the host's, where KOS's browser
 * and, nearly always, the owner's Chrome run. A computer's are a Mac's
 * whatever this says (keyPlatformOf).
 */
export const HOST_KEYS: KeyPlatform = process.platform === "darwin" ? "mac" : "other";
