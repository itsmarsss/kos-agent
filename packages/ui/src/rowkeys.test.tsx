// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rowKeys } from "./rowkeys.js";

function Rows({ open }: { open: (n: number) => void }): ReactElement {
  return (
    <table>
      <tbody data-rows="">
        {[1, 2, 3].map((n) => (
          <tr key={n} {...rowKeys(() => open(n))} aria-label={`row ${n}`}>
            <td>
              <button type="button">Fix {n}</button>
            </td>
          </tr>
        ))}
        <tr>
          <th>a group head between rows</th>
        </tr>
        <tr {...rowKeys(() => open(4))} aria-label="row 4">
          <td>4</td>
        </tr>
      </tbody>
    </table>
  );
}

describe("rowKeys", () => {
  afterEach(cleanup);

  it("makes each row one Tab stop that Enter and Space open", () => {
    const open = vi.fn();
    const { getByLabelText } = render(<Rows open={open} />);
    const row = getByLabelText("row 2");
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(2);
  });

  it("walks rows with the arrows, past a group head, and Home and End", () => {
    const { getByLabelText } = render(<Rows open={() => undefined} />);
    const first = getByLabelText("row 1");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getByLabelText("row 2"));
    fireEvent.keyDown(getByLabelText("row 3"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(getByLabelText("row 4"));
    fireEvent.keyDown(getByLabelText("row 4"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(getByLabelText("row 3"));
    fireEvent.keyDown(getByLabelText("row 3"), { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(getByLabelText("row 4"));
  });

  it("leaves a key pressed on a control inside the row to the control", () => {
    const open = vi.fn();
    const { getByText } = render(<Rows open={open} />);
    fireEvent.keyDown(getByText("Fix 1"), { key: "Enter" });
    fireEvent.keyDown(getByText("Fix 1"), { key: "ArrowDown" });
    expect(open).not.toHaveBeenCalled();
  });
});
