import { useId, useState, type ReactElement } from "react";

import { announce } from "./Announcer.js";
import { CheckIcon, CopyIcon } from "./icons.js";

/** Lines a code block shows before it folds; past this, Show all opens the rest. */
export const CODE_FOLD_LINES = 16;

/**
 * A code block in KOS's words: its language and a Copy in a head over it,
 * and a long one folded to its first lines with Show all under it. A 70-line
 * block stood 1500 px tall in the thread with no way to take the code.
 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactElement {
  const lines = code.split("\n").length;
  const long = lines > CODE_FOLD_LINES;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        announce("Code copied");
        setTimeout(() => setCopied(false), 1200);
      },
      () => announce("Could not copy the code", "assertive"),
    );
  };
  return (
    <div className={`md-code-block${long && !open ? " is-folded" : ""}`}>
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "Code"}</span>
        <button type="button" className="md-code-copy" onClick={copy} aria-label={copied ? "Copied the code" : `Copy the ${lang ? `${lang} ` : ""}code`}>
          {copied ? <CheckIcon size={12} title="" /> : <CopyIcon size={12} title="" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="md-code" id={id} data-lang={lang || undefined} style={long && !open ? { maxHeight: `${CODE_FOLD_LINES * 1.5}em` } : undefined}>
        <code>{code}</code>
      </pre>
      {long && (
        <button type="button" className="md-code-fold" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : `Show all ${lines} lines`}
        </button>
      )}
    </div>
  );
}
