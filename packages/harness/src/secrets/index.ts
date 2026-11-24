export { HARNESS_ENV, SecretsRegistry } from "./secrets.js";
export { hasSecretRef, placeSecrets, usesSecret, type Placed, type SecretSlots } from "./inject.js";
export { Scrubber, scrubDeep } from "./scrub.js";
export { scrubShapes } from "./shapes.js";
export { Vault, VaultError, vaultDir, type SecretMeta, type SecretRecord } from "./vault.js";
export { secretsRoutes, SECRETS_PREFIX, type SecretsRoutesDeps } from "./routes.js";
