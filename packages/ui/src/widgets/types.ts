import type { MutationTarget, Widget } from "@kos/shared";
import type { ReactElement } from "react";

import type { MutateKey, MutateOp } from "../api.js";

/** One row of a display query's read-only result set. */
export type Row = Record<string, unknown>;

/**
 * The guarded mutation path, handed to a write-capable widget by the renderer.
 * A widget describes the edit it wants in its own idiom; the runner sends it as
 * page id plus widget index, and the server resolves the target table and the
 * editable columns from the stored spec. The widget cannot name a table.
 */
export interface WidgetMutation {
  run: (
    op: MutateOp,
    values?: Record<string, unknown>,
    key?: MutateKey,
  ) => Promise<void>;
}

export interface WidgetProps {
  widget: Widget;
  rows: Row[];
  /** Absent when the page is rendered without a live API (previews, tests). */
  mutate?: WidgetMutation;
}

export type WidgetRenderer = (props: WidgetProps) => ReactElement;

/** Mutations a target permits; the declared default is insert plus update. */
export function allows(
  target: MutationTarget | undefined,
  op: MutateOp,
): boolean {
  if (!target) return false;
  return (target.allow ?? ["insert", "update"]).includes(op);
}
