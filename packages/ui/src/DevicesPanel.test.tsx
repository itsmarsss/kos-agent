// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type PairedDevice } from "./api.js";
import { describeDevice, DevicesPanel, pairingLink } from "./DevicesPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const laptop: PairedDevice = {
  id: "dev_1",
  name: "Studio MacBook",
  platform: "macos",
  pairedAt: 0,
  lastSeen: 0,
  online: true,
  consent: "device",
  permissions: { screen: true, input: true },
  os: "26.4.1",
};

describe("a paired computer, in words", () => {
  it("says where it stands and what it is missing", () => {
    expect(describeDevice(laptop)).toBe("macOS 26.4.1 · asks on the computer");
    expect(describeDevice({ ...laptop, consent: "kos", permissions: { screen: false, input: true } })).toBe(
      "macOS 26.4.1 · starts through your approvals · Needs Screen Recording on the computer",
    );
    expect(describeDevice({ ...laptop, online: false, lastSeen: 1_000 }, 1_000 + 3 * 3_600_000)).toBe("Offline, last seen 3h ago");
    expect(describeDevice({ ...laptop, online: false, lastSeen: null })).toMatch(/Never connected/);
    expect(describeDevice({ ...laptop, session: { conversation: "c", title: "Design", task: "export the deck", until: Date.now() + 60_000, paused: true } })).toMatch(
      /Paused by you: Design, "export the deck", until/,
    );
    expect(
      describeDevice({ ...laptop, session: { conversation: "c", title: "Design", task: "t", until: Date.now() + 60_000, paused: false, target: { kind: "window", app: "Figma" } } }),
    ).toMatch(/In use: Design, "t", in Figma, until/);
  });

  it("opens KOS Device with this dashboard's address and the code", () => {
    expect(pairingLink("http://127.0.0.1:4317", "K7QX-M2PA")).toBe("kos-device://pair?url=http%3A%2F%2F127.0.0.1%3A4317&code=K7QX-M2PA");
  });
});

describe("the Devices panel", () => {
  it("lets the owner keep work they did not start off their computers", async () => {
    vi.spyOn(api, "devices").mockResolvedValue({ devices: [laptop], settings: { askMinutes: 15, unattended: false } });
    const set = vi.spyOn(api, "setComputerSettings").mockResolvedValue({ askMinutes: 15, unattended: true });
    render(<DevicesPanel />);
    const toggle = await screen.findByRole("checkbox");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ unattended: true });
  });

  it("lists the computers and stops a session from here", async () => {
    vi.spyOn(api, "devices").mockResolvedValue({
      devices: [{ ...laptop, session: { conversation: "c", title: "Design", task: "t", until: Date.now() + 60_000, paused: false } }],
      settings: { askMinutes: 15, unattended: false },
    });
    const stop = vi.spyOn(api, "stopDevice").mockResolvedValue({ stopped: true });
    render(<DevicesPanel />);
    expect(await screen.findByText("Studio MacBook")).toBeTruthy();
    expect(screen.getByText("in use")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledWith("dev_1");
  });

  it("makes a code to pair with, and puts it away once a computer used it", async () => {
    const devices = vi.spyOn(api, "devices").mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false } });
    vi.spyOn(api, "deviceCode").mockResolvedValue({ code: "K7QX-M2PA", expiresAt: Date.now() + 10 * 60_000 });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DevicesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a device" }));
    expect(await screen.findByLabelText("Pairing code")).toBeTruthy();
    expect(screen.getByText("Open KOS Device").getAttribute("href")).toMatch(/^kos-device:\/\/pair\?url=.*&code=K7QX-M2PA$/);
    expect(screen.getByText(/Good for 10 more minutes, once/)).toBeTruthy();

    devices.mockResolvedValue({ devices: [laptop], settings: { askMinutes: 15, unattended: false } });
    await vi.advanceTimersByTimeAsync(3_100);
    await waitFor(() => expect(screen.getByText("Paired Studio MacBook.")).toBeTruthy());
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    vi.useRealTimers();
  });
});
