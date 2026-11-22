import { useEffect, useState, type ReactElement } from "react";

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
  const [name, setName] = useState("");
  useEffect(() => {
    if (suggested !== null) setName(suggested);
  }, [suggested]);
  const clean = name.trim();
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
            <button type="submit" form={FORM} className="btn btn--primary" disabled={clean === "" || clean.includes("/")}>
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
          if (clean && !clean.includes("/")) onMake(clean);
        }}
      >
        <Field label="Name" hint="In the workspace itself, where it cannot be renamed later.">
          <input className="kos-input" value={name} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
