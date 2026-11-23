import type { ReactElement } from "react";

import { Modal } from "./Modal.js";
import { keyWords, SHORTCUTS } from "./shortcuts.js";

/** The "?" sheet: every key there is, by where it works. */
export function KeysSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  return (
    <Modal open={open} title="Keyboard shortcuts" onClose={onClose}>
      <div className="keys-sheet">
        {SHORTCUTS.map((group) => (
          <section key={group.where} className="keys-group">
            <h3 className="label">{group.where}</h3>
            <dl>
              {group.keys.map((k) => (
                <div key={k.keys + k.does} className="keys-row">
                  <dt>
                    {k.keys.split(/\s{2,}/).map((cap) => (
                      <kbd key={cap} aria-hidden="true">{cap}</kbd>
                    ))}
                    <span className="sr-only">{k.keys.split(/\s{2,}/).map(keyWords).join(", ")}</span>
                  </dt>
                  <dd>{k.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
