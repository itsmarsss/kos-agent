// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useLeaveGuard } from "./leaveguard.js";

/** Whether leaving now would be asked about: a beforeunload some listener cancelled. */
function asksToLeave(): boolean {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

afterEach(cleanup);

describe("useLeaveGuard", () => {
  it("asks before leaving only while something is unsaved", () => {
    const { rerender } = renderHook(({ unsaved }) => useLeaveGuard(unsaved), { initialProps: { unsaved: false } });
    expect(asksToLeave()).toBe(false);
    rerender({ unsaved: true });
    expect(asksToLeave()).toBe(true);
    rerender({ unsaved: false });
    expect(asksToLeave()).toBe(false);
  });

  it("stops asking once the page is gone", () => {
    const { unmount } = renderHook(() => useLeaveGuard(true));
    unmount();
    expect(asksToLeave()).toBe(false);
  });
});
