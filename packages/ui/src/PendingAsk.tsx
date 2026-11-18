import { useMemo, type ReactElement, type ReactNode } from "react";

import { askView, type AskView, type KeyPlatform } from "@kos/shared";
import { AskCard } from "@kos/kit";

import type { PendingAction } from "./api.js";

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
  const view = askView({ tool: a.tool, args: a.args, reason: a.reason, rule: a.rule ?? null, ...(a.yours ? { yours: true } : {}), platform: viewerKeys() });
  return a.title ? { ...view, title: a.title } : view;
}

/**
 * The dashboard's approval card for one waiting ask, wherever it waits: the
 * Inbox, Needs you on Home, a chat, a build's terminal. A handoff is done
 * or can't be, never kept.
 */
export function PendingAsk({
  ask,
  deciding,
  onDecide,
  compact,
  bare,
  meta,
  extra,
  children,
}: {
  ask: PendingAction;
  deciding: ReadonlySet<number>;
  onDecide: (id: number, approved: boolean, remember?: boolean) => void;
  compact?: boolean;
  bare?: boolean;
  meta?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  const view = useMemo(() => pendingView(ask), [ask]);
  const handoff = ask.tool === "browser.handoff";
  return (
    <AskCard
      view={view}
      tool={ask.tool}
      args={ask.args}
      why={ask.why}
      asker={ask.asker}
      expiresAt={ask.expiresAt}
      busy={deciding.has(ask.id)}
      onDecide={(approved, remember) => (remember ? onDecide(ask.id, approved, true) : onDecide(ask.id, approved))}
      {...(handoff ? { labels: { yes: "Done", no: "Can't" }, noRemember: true } : {})}
      {...(compact ? { compact } : {})}
      {...(bare ? { bare } : {})}
      meta={meta}
      extra={extra}
    >
      {children}
    </AskCard>
  );
}
