import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { dashboardToken, signedUrl } from "./api.js";

/** How long before a signature lapses the page asks for a fresh one. */
export const RENEW_BEFORE_MS = 60_000;

interface Held {
  of: string;
  url: string;
  expiresAt: number | null;
}

/**
 * `url` as the browser may fetch it by itself: itself with no token held,
 * else KOS's signed address once it has answered (undefined until then).
 * A signature is asked for again shortly before it lapses (unless `renew` is
 * off: a player or a framed PDF would start over), and once when the
 * element fails with it: `again()` says whether it asked.
 */
export function useSignedUrl(url: string, renew = true): { src: string | undefined; again: () => boolean } {
  const held = dashboardToken() !== undefined;
  const [signed, setSigned] = useState<Held>();
  const [round, setRound] = useState(0);
  // Signed again for a failure since the last renewal: another failure is the file's, not the signature's.
  const retried = useRef(false);
  useEffect(() => {
    if (!held) return;
    let live = true;
    void signedUrl(url).then(
      (got) => live && setSigned({ of: url, url: got.url, expiresAt: got.expiresAt }),
      // Refused or unreachable: nothing to point at, and the token prompt says why.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url, held, round]);
  useEffect(() => {
    retried.current = false;
  }, [url]);
  const current = held && signed?.of === url ? signed : undefined;
  useEffect(() => {
    if (!renew || current?.expiresAt == null) return;
    const later = setTimeout(() => {
      retried.current = false;
      setRound((r) => r + 1);
    }, Math.max(0, current.expiresAt - Date.now() - RENEW_BEFORE_MS));
    return () => clearTimeout(later);
  }, [renew, current?.expiresAt]);
  const again = useCallback((): boolean => {
    if (!current || retried.current) return false;
    retried.current = true;
    setRound((r) => r + 1);
    return true;
  }, [current]);
  return { src: held ? current?.url : url, again };
}

/** What draws from `url` (an img, a player, a frame), drawn once the address is one the browser can fetch; `again` is for its onError. */
export function Signed({ url, renew = true, children }: { url: string; renew?: boolean; children: (src: string, again: () => boolean) => ReactElement }): ReactElement | null {
  const { src, again } = useSignedUrl(url, renew);
  return src === undefined ? null : children(src, again);
}
