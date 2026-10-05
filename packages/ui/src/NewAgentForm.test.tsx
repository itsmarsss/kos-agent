// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { NewAgentForm } from "./NewAgentForm.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("starting an agent by hand", () => {
  it("sends the name, brief and first task, then opens what was made", async () => {
    const create = vi.spyOn(api, "createProjectAgent").mockResolvedValue({ id: "c9:owner", started: true } as never);
    const onMade = vi.fn();
    render(<NewAgentForm slug="kitchen_redo" onMade={onMade} onCancel={() => {}} onError={() => {}} />);

    expect((screen.getByText("Start agent") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Agent name/), { target: { value: "Paint" } });
    fireEvent.change(screen.getByPlaceholderText(/Brief/), { target: { value: "You choose colours." } });
    fireEvent.change(screen.getByPlaceholderText(/First task/), { target: { value: "Pick a colour." } });
    fireEvent.click(screen.getByText("Start agent"));

    await waitFor(() => expect(onMade).toHaveBeenCalledWith("c9:owner"));
    expect(create).toHaveBeenCalledWith("kitchen_redo", {
      title: "Paint",
      brief: "You choose colours.",
      task: "Pick a colour.",
    });
  });

  it("leaves out an empty brief and task, and reports a refusal", async () => {
    vi.spyOn(api, "createProjectAgent").mockRejectedValue(new Error("project kitchen_redo is archived"));
    const onError = vi.fn();
    const onMade = vi.fn();
    render(<NewAgentForm slug="kitchen_redo" onMade={onMade} onCancel={() => {}} onError={onError} />);

    fireEvent.change(screen.getByPlaceholderText(/Agent name/), { target: { value: "  Paint " } });
    fireEvent.click(screen.getByText("Start agent"));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("project kitchen_redo is archived"));
    expect(api.createProjectAgent).toHaveBeenCalledWith("kitchen_redo", { title: "Paint" });
    expect(onMade).not.toHaveBeenCalled();
  });
});
