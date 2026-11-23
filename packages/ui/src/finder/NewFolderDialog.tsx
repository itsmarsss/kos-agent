import { useState, type ReactElement } from "react";

import { Field, SheetFoot } from "@kos/kit";

import { Modal } from "../Modal.js";

const FORM = "file-new-folder-form";

/**
 * A new folder named before it is made. At the workspace's top level what
 * is there is its layout, which cannot be renamed after (the server says
 * so), so a folder made there as "untitled folder" and renamed in place
 * kept that name for good.
 */
export function NewFolderDialog({ suggested, onMake, onClose }: { suggested: string | null; onMake: (name: string) => void; onClose: () => void }): ReactElement {
  // Taken in the render the dialog opens in, not an effect after it: the
  // field took the focus empty, selected nothing, and a name typed on a phone
  // went after "untitled folder".
  const [name, setName] = useState(suggested ?? "");
  const [shown, setShown] = useState(suggested);
  if (suggested !== shown) {
    setShown(suggested);
    if (suggested !== null) setName(suggested);
  }
  const clean = name.trim();
  const valid = clean !== "" && !clean.includes("/");
  return (
    <Modal
      open={suggested !== null}
      size="sm"
      title="New folder"
      onClose={onClose}
      footer={
        <SheetFoot
          onCancel={onClose}
          primary={
            <button type="submit" form={FORM} className="btn btn--primary" disabled={!valid}>
              Create
            </button>
          }
        />
      }
    >
      <form
        id={FORM}
        className="file-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onMake(clean);
        }}
      >
        <Field label="Name" hint="In the workspace itself, where it cannot be renamed later.">
          <input
            className="kos-input"
            value={name}
            autoFocus
            enterKeyHint="done"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // Return makes it from a phone's keyboard too, whose Return the form's own submit did not see.
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (valid) onMake(clean);
              }
            }}
          />
        </Field>
      </form>
    </Modal>
  );
}
