// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type SettingsPayload } from "./api.js";
import { SettingsPage } from "./SettingsPage.js";

const retention = { maxChars: 1000, maxToolResultChars: 1000, maxExchanges: 10, autoTrim: true };
const payload = (name: string): SettingsPayload =>
  ({
    workspace: "/w",
    profile: { name, timezone: "UTC", ownerId: "owner" },
    retention,
    retentionDefaults: retention,
    buildModel: null,
    halted: false,
    envPath: "/env",
    envWritable: true,
    secrets: {},
    settings: {},
    sitesUrl: null,
  }) as unknown as SettingsPayload;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
});

let stored = "Ada";
beforeEach(() => {
  stored = "Ada";
  vi.spyOn(api, "settings").mockImplementation(() => Promise.resolve(payload(stored)));
  vi.spyOn(api, "behaviour").mockRejectedValue(new Error("not here"));
  vi.spyOn(api, "saveProfile").mockImplementation((name: string) => {
    stored = name;
    return Promise.resolve(undefined as never);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  it("saves on Enter in a field and then says Saved, Save off until the next change", async () => {
    render(<SettingsPage section="you" />);
    const name = (await screen.findByDisplayValue("Ada")) as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Grace" } });
    expect(screen.getByText("Not saved yet")).toBeTruthy();
    expect(save.disabled).toBe(false);
    fireEvent.keyDown(name, { key: "Enter" });
    expect(api.saveProfile).toHaveBeenCalledWith("Grace", "UTC");
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(screen.queryByText("Not saved yet")).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves Enter alone when nothing has changed", async () => {
    render(<SettingsPage section="you" />);
    const name = await screen.findByDisplayValue("Ada");
    fireEvent.keyDown(name, { key: "Enter" });
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it("moves the focus into the section a search opens", async () => {
    render(<SettingsPage section="providers" />);
    await screen.findByText("Providers", { selector: "h1, h2" });
    const search = screen.getByPlaceholderText("Search settings");
    search.focus();
    fireEvent.change(search, { target: { value: "you" } });
    fireEvent.keyDown(search, { key: "Enter" });
    const name = (await screen.findByDisplayValue("Ada")) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).not.toBe(search));
    expect(document.activeElement?.closest(".set-pane")).toBeTruthy();
    expect(name).toBeTruthy();
  });
});
