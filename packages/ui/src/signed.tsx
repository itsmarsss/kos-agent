import { useEffect, useState, type ReactElement } from "react";

import { dashboardToken, signedUrl } from "./api.js";

/** `url` as the browser may fetch it by itself: itself with no token held, KOS's signed address once it has answered, undefined until then. */
export function useSignedUrl(url: string): string | undefined {
  const held = dashboardToken() !== undefined;
  const [signed, setSigned] = useState<{ of: string; url: string }>();
  useEffect(() => {
    if (!held) return;
    let live = true;
    void signedUrl(url).then(
      (got) => live && setSigned({ of: url, url: got }),
      // Refused or unreachable: nothing to point at, and the token prompt says why.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url, held]);
  if (!held) return url;
  return signed?.of === url ? signed.url : undefined;
}

/** What draws from `url` (an img, a player, a frame), drawn once the address is one the browser can fetch. */
export function Signed({ url, children }: { url: string; children: (src: string) => ReactElement }): ReactElement | null {
  const src = useSignedUrl(url);
  return src === undefined ? null : children(src);
}
