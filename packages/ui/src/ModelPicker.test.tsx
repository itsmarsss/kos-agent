// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { MODELS_HREF, ModelPicker } from "./ModelPicker.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});

function mockModels(engine: "api" | "sdk", model: string, models: string[]): void {
  vi.spyOn(api, "modelSettings").mockResolvedValue({ routes: { reasoning: { provider: "custom", model } } } as unknown as Awaited<ReturnType<typeof api.modelSettings>>);
  vi.spyOn(api, "availableModels").mockResolvedValue({ models } as Awaited<ReturnType<typeof api.availableModels>>);
  vi.spyOn(api, "behaviour").mockResolvedValue({ behaviour: { engine } } as unknown as Awaited<ReturnType<typeof api.behaviour>>);
}

describe("the composer's model chip", () => {
  it("is the way into Settings, Models from its menu's last item", async () => {
    mockModels("api", "stub", []);
    const save = vi.spyOn(api, "saveModelSettings");
    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole("button", { name: "The model for thinking" }));
    fireEvent.click(await screen.findByText("All model settings…"));
    expect(window.location.hash).toBe(MODELS_HREF);
    expect(MODELS_HREF).toBe("#/settings/models");
    expect(save).not.toHaveBeenCalled();
  });

  it("links to Settings, Models when Claude Code picks the model", async () => {
    mockModels("sdk", "stub", []);
    render(<ModelPicker />);
    const link = await screen.findByRole("link", { name: "Claude Code" });
    expect(link.getAttribute("href")).toBe(MODELS_HREF);
  });
});
