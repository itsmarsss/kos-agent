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
    expect(screen.getByText("Weekdays at 07:30")).toBeTruthy();
  });

  it("writes the line from the choices, keeping the time across kinds", () => {
    const onChange = vi.fn();
    render(<SchedulePicker value="30 7 * * 1-5" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    // Weekdays carried over as the days.
    expect(onChange).toHaveBeenLastCalledWith("30 7 * * 1,2,3,4,5");
    fireEvent.click(screen.getByRole("button", { name: "Saturday" }));
    expect(onChange).toHaveBeenLastCalledWith("30 7 * * 1,2,3,4,5,6");
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "18:00" } });
    expect(onChange).toHaveBeenLastCalledWith("0 18 * * 1,2,3,4,5,6");
    fireEvent.click(screen.getByRole("button", { name: "Hourly" }));
    expect(onChange).toHaveBeenLastCalledWith("0 */6 * * *");
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith("0 */2 * * *");
    expect(screen.getByText("Every 2 hours, on the hour")).toBeTruthy();
  });

  it("lets the line be edited as text, and keeps one it cannot read as custom", () => {
    const onChange = vi.fn();
    render(<SchedulePicker value="0 9 * * *" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit as cron" }));
    const line = screen.getByLabelText("The cron line") as HTMLInputElement;
    expect(line.value).toBe("0 9 * * *");
    fireEvent.change(line, { target: { value: "0 9 * 6 *" } });
    expect(onChange).toHaveBeenLastCalledWith("0 9 * 6 *");
    expect(screen.getByRole("button", { name: "Custom" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Not a schedule yet/)).toBeTruthy();
  });

  it("offers Never where a thing may run only when asked", () => {
    const onChange = vi.fn();
    render(<SchedulePicker value="" allowNone onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Never" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Not scheduled/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    expect(onChange).toHaveBeenLastCalledWith("0 9 * * *");
    fireEvent.click(screen.getByRole("button", { name: "Never" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
