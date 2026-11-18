import { hasSecretRef } from "@kos/shared";

import type { ApprovalRequest } from "./types.js";

/**
 * Whether a surface offers a remembered yes for an ask, by one rule
 * everywhere: the ask names the rule a yes would keep, and it does not
 * place a secret, which is asked about every time.
 */
export function offersAlways(req: ApprovalRequest): boolean {
  return req.rule !== undefined && !(req.asksAlways ?? hasSecretRef(req.args ?? {}));
}
