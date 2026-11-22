import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { askView, SECRET_KINDS, type AskView, type KeyPlatform, type SecretKind } from "@kos/shared";
import { AskCard } from "@kos/kit";

import type { PendingAction } from "./api.js";
import { SecretSheet } from "./SecretSheet.js";

/** Whose keyboard this page is read on: keys are said as its caps. */
export function viewerKeys(): KeyPlatform {
  if (typeof navigator === "undefined") return "mac";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "mac" : "other";
}

/**
 * A waiting ask as its card lays it out: read from its arguments here, so
 * the keys are this keyboard's, titled by the host's words where it sent
 * them, since the host names the ids in them.
 */
export function pendingView(a: PendingAction): AskView {
  const view = askView({ tool: a.tool, args: a.args, reason: a.reason, rule: a.rule ?? null, ...(a.yours ? { yours: true } : {}), ...(a.asksAlways ? { asksAlways: true } : {}), ...(a.beyondAuto ? { beyondAuto: true } : {}), ...(a.secret ? { secret: a.secret } : {}), platform: viewerKeys() });
  // The host's words where it sent them: it names the ids in the title and the destination an Always keeps.
  return {
    ...view,
    ...(a.title ? { title: a.title } : {}),
    ...(view.always && a.always ? { always: a.always, ...(a.alwaysTip ? { alwaysTip: a.alwaysTip } : {}) } : {}),
  };
}

/** What a secrets.request asks the owner to add: its kind and label, from the ask's arguments. */
function askedSecret(args: string): { kind: SecretKind; label?: string } {
  try {
    const a = JSON.parse(args) as { kind?: unknown; label?: unknown };
    const kind = (SECRET_KINDS as readonly unknown[]).includes(a.kind) ? (a.kind as SecretKind) : "login";
    return typeof a.label === "string" && a.label.trim() ? { kind, label: a.label.trim() } : { kind };
  } catch {
    return { kind: "login" };
  }
}

/**
 * The dashboard's approval card for one waiting ask, wherever it waits: the
 * Inbox, Needs you on Home, a chat, a build's terminal. A handoff is done
 * or can't be, never kept. A request for a secret opens the new secret's
 * sheet, and is answered once it is saved: the value goes into the vault
 * from the sheet, never into the chat.
 */
export function PendingAsk({
  ask,
  deciding,
  onDecide,
  bare,
  meta,
  extra,
  children,
}: {
  ask: PendingAction;
  deciding: ReadonlySet<number>;
  onDecide: (id: number, approved: boolean, remember?: boolean, code?: string) => void;
  bare?: boolean;
  meta?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  const view = useMemo(() => pendingView(ask), [ask]);
  const handoff = ask.tool === "browser.handoff";
  const request = ask.tool === "secrets.request";
  const [adding, setAdding] = useState(false);
  // A sheet closed without saving leaves the card to be pressed again: a new card, with nothing pressed.
  const [round, setRound] = useState(0);
  return (
    <>
      {request &&
        createPortal(
          <SecretSheet
            open={adding}
            mode={{ kind: "add", asked: askedSecret(ask.args) }}
            onClose={() => {
              setAdding(false);
              setRound((n) => n + 1);
            }}
            onSaved={() => {
              setAdding(false);
              onDecide(ask.id, true);
            }}
          />,
          document.body,
        )}
      <AskCard
        key={round}
        view={view}
        tool={ask.tool}
        args={ask.args}
        why={ask.why}
        asker={ask.asker}
        expiresAt={ask.expiresAt}
        busy={deciding.has(ask.id)}
        onDecide={(approved, remember, code) => (request && approved ? setAdding(true) : code !== undefined ? onDecide(ask.id, approved, false, code) : remember ? onDecide(ask.id, approved, true) : onDecide(ask.id, approved))}
        {...(handoff ? { labels: { yes: "Done", no: "Can't" }, noRemember: true } : {})}
        {...(request ? { labels: { yes: "Add it", no: "Not now" }, noRemember: true } : {})}
        {...(bare ? { bare } : {})}
        meta={meta}
        extra={extra}
      >
        {children}
      </AskCard>
    </>
  );
}
