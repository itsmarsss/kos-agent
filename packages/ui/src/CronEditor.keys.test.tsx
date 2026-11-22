// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type CronJob } from "./api.js";
import { CronEditor } from "./CronEditor.js";

beforeEach(() => {
  vi.spyOn(api, "skills").mockResolvedValue({ skills: [] } as never);
  vi.spyOn(api, "createCron").mockResolvedValue({} as CronJob);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("New schedule from the keys", () => {
  it("creates on Enter in the name and says it was made", async () => {
    const done = vi.fn();
    const notice = vi.fn();
    render(<CronEditor onDone={done} onCancel={() => undefined} onNotice={notice} />);
    const name = screen.getByPlaceholderText("Morning summary");
    fireEvent.change(name, { target: { value: "Morning summary" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(api.createCron).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(notice).toHaveBeenCalledWith("Made Morning summary");
  });

  it("creates on Cmd+Enter in the prompt, while a bare Enter there is a new line", () => {
    render(<CronEditor onDone={() => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText("Morning summary"), { target: { value: "Weekly" } });
    const prompt = screen.getByPlaceholderText(/expenses/);
    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(api.createCron).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    expect(api.createCron).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Enter with no name yet", () => {
    render(<CronEditor onDone={() => undefined} onCancel={() => undefined} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Morning summary"), { key: "Enter" });
    expect(api.createCron).not.toHaveBeenCalled();
  });
});
