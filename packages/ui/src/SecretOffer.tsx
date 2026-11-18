import { useMemo, useRef, useState, type ReactElement } from "react";

import { CloseIcon, IconButton } from "@kos/kit";

import { detectSecret, withoutSecret } from "./composer.js";
import { SecretSheet, type SecretSeed } from "./SecretSheet.js";

/**
 * Over the composer, when the draft holds what looks like a secret: an
 * offer to keep it as one instead of sending it. Taken, the value leaves
 * the draft and goes, in memory, into a new secret's sheet; it is in no
 * address and no state but the field it is typed into.
 */
export function SecretOffer({ draft, onDraft }: { draft: string; onDraft: (next: string) => void }): ReactElement {
  const found = useMemo(() => detectSecret(draft), [draft]);
  /** The offer turned down, by where it was and its length: never by the value. */
  const [declined, setDeclined] = useState<string | null>(null);
  const seed = useRef<SecretSeed | null>(null);
  const [open, setOpen] = useState(false);
  const key = found ? `${found.kind}:${found.start}:${found.end - found.start}` : null;

  const close = (): void => {
    seed.current = null;
    setOpen(false);
  };
  return (
    <>
      {found && key !== declined && (
        <div className="secret-offer" role="status">
          <span className="secret-offer-text">This looks like {found.what}.</span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              seed.current = { kind: found.kind, field: found.field, value: found.value };
              onDraft(withoutSecret(draft, found));
              setOpen(true);
            }}
          >
            Save as a secret instead
          </button>
          <IconButton tone="bare" label="Send it as it is" onClick={() => setDeclined(key)}>
            <CloseIcon size={12} title="" />
          </IconButton>
        </div>
      )}
      <SecretSheet open={open} mode={seed.current ? { kind: "add", seed: seed.current } : { kind: "add" }} onClose={close} onSaved={close} />
    </>
  );
}
