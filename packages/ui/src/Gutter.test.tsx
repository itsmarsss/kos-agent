// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Gutter } from "./Gutter.js";

function handle(grows: "right" | "up", value = 160): { el: HTMLElement; sizes: number[]; done: number[] } {
  const sizes: number[] = [];
  const done: number[] = [];
  const { container } = render(
    <Gutter label="the thing" value={value} min={64} max={480} fallback={160} grows={grows} onChange={(n) => sizes.push(n)} onDone={(n) => done.push(n)} />,
  );
  const el = container.querySelector("button")!;
  // jsdom has no pointer capture; the handle asks for it on every press.
  (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => undefined;
  return { el, sizes, done };
}

describe("Gutter", () => {
  it("moves a column with the pointer's x, and a row with its y", () => {
    const column = handle("right");
    fireEvent.pointerDown(column.el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(column.el, { clientX: 140, clientY: 300 });
    expect(column.sizes).toEqual([200]);
    expect(column.el.getAttribute("aria-orientation")).toBe("vertical");

    // A row below the handle grows as the handle moves up.
    const row = handle("up");
    fireEvent.pointerDown(row.el, { button: 0, clientX: 100, clientY: 400 });
    fireEvent.pointerMove(row.el, { clientX: 500, clientY: 370 });
    fireEvent.pointerUp(row.el, { clientX: 500, clientY: 370 });
    expect(row.sizes).toEqual([190, 190]);
    expect(row.done).toEqual([190]);
    expect(row.el.getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("takes the arrow keys along its own axis, and stays within bounds", () => {
    const row = handle("up", 72);
    fireEvent.keyDown(row.el, { key: "ArrowUp" });
    expect(row.sizes).toEqual([88]);
    fireEvent.keyDown(row.el, { key: "ArrowRight" });
    expect(row.sizes).toEqual([88]);
    const low = handle("up", 70);
    fireEvent.keyDown(low.el, { key: "ArrowDown" });
    expect(low.sizes).toEqual([64]);
    fireEvent.dblClick(low.el);
    expect(low.done).toEqual([64, 160]);
  });
});
