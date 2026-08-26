import { useCallback, useState } from "react";

import type { MutateKey, MutateOp } from "../api.js";
import type { WidgetMutation } from "./types.js";

interface RunnerState {
  pending: boolean;
  error: string | null;
  saved: boolean;
}

export interface MutationRunner extends RunnerState {
  /** Runs one guarded mutation; resolves true when the write succeeded. */
  run: (
    op: MutateOp,
    values?: Record<string, unknown>,
    key?: MutateKey,
  ) => Promise<boolean>;
  reset: () => void;
}

const IDLE: RunnerState = { pending: false, error: null, saved: false };

/**
 * Shared write plumbing for the write-capable widgets: one in-flight guard, one
 * error slot, one saved flag. A failed mutation surfaces in the widget, never as
 * a thrown render error, so a bad write cannot trip the error boundary.
 */
export function useMutationRunner(mutate?: WidgetMutation): MutationRunner {
  const [state, setState] = useState<RunnerState>(IDLE);

  const run = useCallback(
    async (
      op: MutateOp,
      values?: Record<string, unknown>,
      key?: MutateKey,
    ): Promise<boolean> => {
      if (!mutate) {
        setState({ pending: false, error: "no write path available", saved: false });
        return false;
      }
      setState({ pending: true, error: null, saved: false });
      try {
        await mutate.run(op, values, key);
        setState({ pending: false, error: null, saved: true });
        return true;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        setState({ pending: false, error, saved: false });
        return false;
      }
    },
    [mutate],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, run, reset };
}
