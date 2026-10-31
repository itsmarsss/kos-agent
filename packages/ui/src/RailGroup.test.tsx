// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RailGroup, useRailFolds } from "./RailGroup.js";

const SHUT = ["scheduled"] as const;

function Rail(): React.ReactElement {
  const folds = useRailFolds(SHUT);
  return (
    <>
      {["projects", "scheduled"].map((id) => (
        <RailGroup key={id} title={id} count={2} open={folds.isOpen(id)} onToggle={() => folds.toggle(id)}>
          <p>{`${id} rows`}</p>
        </RailGroup>
      ))}
    </>
  );
}

const head = (container: HTMLElement, id: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>(".rail-group-fold")].find((b) => b.querySelector(".rail-group-title")?.textContent === id)!;

afterEach(() => localStorage.clear());

describe("RailGroup", () => {
  it("starts as the defaults say, folds on a press, and remembers it", () => {
    const first = render(<Rail />);
    expect(head(first.container, "projects").getAttribute("aria-expanded")).toBe("true");
    expect(head(first.container, "scheduled").getAttribute("aria-expanded")).toBe("false");
    expect(first.queryByText("scheduled rows")).toBeNull();

    fireEvent.click(head(first.container, "projects"));
    fireEvent.click(head(first.container, "scheduled"));
    expect(head(first.container, "projects").getAttribute("aria-expanded")).toBe("false");
    expect(first.getByText("scheduled rows")).toBeTruthy();
    first.unmount();

    // The next visit opens as it was left.
    const again = render(<Rail />);
    expect(head(again.container, "projects").getAttribute("aria-expanded")).toBe("false");
    expect(head(again.container, "scheduled").getAttribute("aria-expanded")).toBe("true");
  });

  it("holds still without a toggle, and says a note in place of the count", () => {
    const { container } = render(
      <RailGroup title="Scheduled" count={15} note="2 running" open>
        <p>rows</p>
      </RailGroup>,
    );
    const fold = container.querySelector<HTMLButtonElement>(".rail-group-fold")!;
    expect(fold.disabled).toBe(true);
    expect(container.querySelector(".rail-group-note")?.textContent).toBe("2 running");
    expect(container.querySelector(".rail-group-count")).toBeNull();
  });
});
