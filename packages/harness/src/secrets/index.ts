export { SecretsRegistry } from "./secrets.js";
export { hasSecretRef, placeSecrets, usesSecret, type Placed, type SecretSlots } from "./inject.js";
export { Scrubber, scrubDeep } from "./scrub.js";
export { scrubShapes } from "./shapes.js";
export { Vault, VaultError, vaultDir, type DeviceSlotInfo, type DeviceUnwrapper, type DeviceUnwrapRequest, type SecretMeta, type SecretRecord } from "./vault.js";
export { deviceInfo, keyFrom, openFromDevice, p256Pair, P256_POINT_BYTES, sealToHost, type P256Pair, type UnwrapAnswer } from "./vaultkeys.js";
export { secretsRoutes, SECRETS_PREFIX, type SecretsRoutesDeps, type VaultDevices } from "./routes.js";
export { Verifiers, type VerifierName } from "./verifiers.js";
export { harnessNameOf, HARNESS_KEYS } from "./secrets.js";
