import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { CloseIcon, IconButton } from "@kos/kit";

import { detectSecret, withoutSecret } from "./composer.js";
import { SecretSheet, type SecretSeed } from "./SecretSheet.js";
import { secretsApi } from "./secrets.js";

/** What was taken out of the draft, kept only until it is saved, put back or let go. */
interface Taken {
  seed: SecretSeed;
  /** The draft as it was, and as it was left, so putting it back restores it exactly when nothing was typed since. */
  before: string;
  after: string;
}

/**
 * Over the composer, when the draft holds what looks like a secret and the
 * vault is open: an offer to keep it as one instead of sending it. Taken,
 * the value leaves the draft and goes, in memory, into a new secret's
 * sheet; it is in no address and no state but the field it is typed into.
 * Closed without saving, the sheet leaves an offer to put it back.
 */
export function SecretOffer({ draft, onDraft }: { draft: string; onDraft: (next: string) => void }): ReactElement {
  const found = useMemo(() => detectSecret(draft), [draft]);
  /** The offer turned down, by where it was and its length: never by the value. */
  const [declined, setDeclined] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const taken = useRef<Taken | null>(null);
  const [open, setOpen] = useState(false);
  const [putBack, setPutBack] = useState(false);
  const key = found ? `${found.kind}:${found.start}:${found.end - found.start}` : null;

  // Asked when there is something to offer, so a vault locked or absent offers nothing it could not keep.
  useEffect(() => {
    if (!key) return;
    let live = true;
    secretsApi
      .status()
      .then((s) => live && setReady(s.state === "ready"))
      .catch(() => live && setReady(false));
    return () => {
      live = false;
    };
  }, [key]);

  const close = (saved: boolean): void => {
    setOpen(false);
    if (saved) taken.current = null;
    setPutBack(!saved && taken.current !== null);
  };
  const restore = (): void => {
    const t = taken.current;
    taken.current = null;
    setPutBack(false);
    if (!t) return;
    onDraft(draft === t.after ? t.before : `${draft.replace(/\s+$/, "")} ${t.seed.value}`.trim());
  };
  const letGo = (): void => {
    taken.current = null;
    setPutBack(false);
  };

  return (
    <>
      {putBack ? (
        <div className="secret-offer" role="status">
          <span className="secret-offer-text">Not saved as a secret.</span>
          <button type="button" className="btn btn--sm" onClick={restore}>
            Put it back in the draft
          </button>
          <IconButton tone="bare" label="Leave it out" onClick={letGo}>
            <CloseIcon size={12} title="" />
          </IconButton>
        </div>
      ) : (
        found &&
        ready &&
        key !== declined &&
        !open && (
          <div className="secret-offer" role="status">
            <span className="secret-offer-text">This looks like {found.what}.</span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                const after = withoutSecret(draft, found);
                taken.current = { seed: { kind: found.kind, field: found.field, value: found.value }, before: draft, after };
                onDraft(after);
                setOpen(true);
              }}
            >
              Save as a secret instead
            </button>
            <IconButton tone="bare" label="Send it as it is" onClick={() => setDeclined(key)}>
              <CloseIcon size={12} title="" />
            </IconButton>
          </div>
        )
      )}
      {/* At the body: a composer can be a form itself (the landing's), and a form holds no form. */}
      {createPortal(<SecretSheet open={open} mode={{ kind: "add", takeSeed: () => taken.current?.seed ?? null }} onClose={() => close(false)} onSaved={() => close(true)} />, document.body)}
    </>
  );
}
