// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulePicker } from "./SchedulePicker.js";

afterEach(cleanup);

describe("the schedule picker", () => {
  it("reads a line as its shape and says it in words", () => {
    render(<SchedulePicker value="30 7 * * 1-5" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Weekdays" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("07:30");
    expect(screen.getByText(/^Weekdays at 0?7:30/)).toBeTruthy();
  });

  it("writes the line from the choices, keeping the time across kinds", () => {
    const onChange = vi.fn();
    render(<SchedulePicker value="30 7 * * 1-5" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Some days" }));
    // Weekdays carried over as the days.
    expect(onChange).toHaveBeenLastCalledWith("30 7 * * 1,2,3,4,5");
    fireEvent.click(screen.getByRole("button", { name: "Saturday" }));
    expect(onChange).toHaveBeenLastCalledWith("30 7 * * 1,2,3,4,5,6");
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "18:00" } });
    expect(onChange).toHaveBeenLastCalledWith("0 18 * * 1,2,3,4,5,6");
    fireEvent.click(screen.getByRole("button", { name: "Every few hours" }));
    expect(onChange).toHaveBeenLastCalledWith("0 */6 * * *");
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith("0 */2 * * *");
    expect(screen.getByText("Every 2 hours, on the hour")).toBeTruthy();
  });

  it("keeps the line an advanced option, and opens it for a line the choices cannot write", () => {
    const onChange = vi.fn();
    render(<SchedulePicker value="0 9 * * *" onChange={onChange} />);
    expect(screen.queryByLabelText("The cron line")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced: write the line" }));
    const line = screen.getByLabelText("The cron line") as HTMLInputElement;
    expect(line.value).toBe("0 9 * * *");
    fireEvent.change(line, { target: { value: "0 9 1-7 * 1" } });
    expect(onChange).toHaveBeenLastCalledWith("0 9 1-7 * 1");
    // No chip is the line's shape now, and it is still a schedule, said as one.
    for (const chip of screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"))) expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/On a schedule of its own/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says what is wrong with a line that is no schedule", () => {
    const onChange = vi.fn();
    render(<SchedulePicker value="0 99 * * *" onChange={onChange} />);
    expect(screen.getByLabelText("The cron line")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The hour must be 0 to 23, *, or a range such as 0-2.");
    fireEvent.click(screen.getByRole("button", { name: "Weekdays" }));
    expect(onChange).toHaveBeenLastCalledWith("0 9 * * 1-5");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers Never where a thing may run only when asked", () => {
    const onChange = vi.fn();
    render(<SchedulePicker value="" allowNone onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Never" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Not scheduled/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Every day" }));
    expect(onChange).toHaveBeenLastCalledWith("0 9 * * *");
    fireEvent.click(screen.getByRole("button", { name: "Never" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
