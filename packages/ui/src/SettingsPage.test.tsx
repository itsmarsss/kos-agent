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

  it("shows the catch-up limit beside the other schedule limits and saves it", async () => {
    const how = { engine: "api", autoFix: true, maxSteps: 50, screenSteps: 200, fixSteps: 24, selfPromptsPerHour: 10, catchUpHours: 3, agentMinutes: 15, agentTurns: 60, stallMinutes: 3, approvalMinutes: 30, approvalExpiryHours: 24, heartbeatMinutes: 0, memoryExtraction: true, smartContext: true, extractEveryChars: 6000, memoryDecideAbove: 80 } as const;
    vi.spyOn(api, "behaviour").mockResolvedValue({ behaviour: how, defaults: how, limits: { catchUpHours: [0, 24], selfPromptsPerHour: [0, 120] } } as unknown as Awaited<ReturnType<typeof api.behaviour>>);
    const save = vi.spyOn(api, "saveBehaviour").mockImplementation((b) => Promise.resolve({ behaviour: b }));
    render(<SettingsPage section="behaviour" />);
    const limit = async (name: RegExp): Promise<HTMLInputElement> => (await screen.findByLabelText(name)).querySelector("input")!;
    const field = await limit(/^Hours a missed schedule may run late/);
    await waitFor(() => expect(field.value).toBe("3"));
    expect(field.min).toBe("0");
    expect(field.max).toBe("24");
    expect(document.body.textContent).toContain("0 never runs a missed one. Usually 3. Between 0 and 24.");
    // Next to the other schedule limit.
    const fields = [...document.querySelectorAll<HTMLInputElement>("input.set-limit")];
    const perHour = await limit(/^Schedules that ask KOS, per hour/);
    expect(fields.indexOf(field)).toBe(fields.indexOf(perHour) + 1);
    fireEvent.change(field, { target: { value: "30" } });
    expect(field.value).toBe("24");
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].catchUpHours).toBe(0);
  });

  it("points a standing rule to where it lives: Memory, or one chat's Brief", async () => {
    render(<SettingsPage section="you" />);
    await screen.findByDisplayValue("Ada");
    expect(screen.getByText(/never message me after 10pm.*is kept in Memory/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Memory" }).getAttribute("href")).toBe("#/memory");
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

  it("says where a key is read from and where a new one goes: the vault while it is open", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({
      ...payload("Ada"),
      keysGo: "vault",
      secrets: {
        OPENAI_API_KEY: { label: "OpenAI", hint: "sk-…", masked: "••••6789", source: "vault" },
        ANTHROPIC_API_KEY: { label: "Anthropic", hint: "sk-ant-…", masked: "••••4321", source: "env" },
      },
    } as SettingsPayload);
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue({ written: ["OPENAI_API_KEY"], cleared: [], stored: "vault" });
    render(<SettingsPage section="providers" />);
    expect(await screen.findByText("in the vault")).toBeTruthy();
    expect(screen.getByText("in .env")).toBeTruthy();
    expect(screen.getByText(/Saved in the encrypted vault, and taken out of .env/)).toBeTruthy();
    const field = screen.getAllByPlaceholderText("Unchanged")[0]!;
    fireEvent.change(field, { target: { value: "sk-proj-new-0123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ OPENAI_API_KEY: "sk-proj-new-0123456789" }));
    expect(await screen.findByText("Saved in the vault")).toBeTruthy();
  });
});
