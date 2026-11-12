// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type PairedDevice } from "./api.js";
import { describeDevice, DevicesPanel, pairingLink, phoneLink } from "./DevicesPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const laptop: PairedDevice = {
  id: "dev_1",
  name: "Studio MacBook",
  platform: "macos",
  kind: "computer",
  pairedAt: 0,
  lastSeen: 0,
  online: true,
  consent: "device",
  permissions: { screen: true, input: true },
  os: "26.4.1",
};

describe("a paired computer, in words", () => {
  it("says where it stands and what it is missing", () => {
    expect(describeDevice(laptop)).toBe("Your computer, macOS 26.4.1, through KOS for Mac · asks on the computer");
    expect(describeDevice({ ...laptop, consent: "kos", permissions: { screen: false, input: true } })).toBe(
      "Your computer, macOS 26.4.1, through KOS for Mac · starts through your approvals · Needs Screen Recording on the computer",
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

  it("says a Chrome is a Chrome, that asks in Chrome and needs no grants", () => {
    const chrome: PairedDevice = { ...laptop, name: "Chrome", platform: "chrome", kind: "browser", os: "macOS", permissions: { screen: false, input: false, tabs: true } };
    expect(describeDevice(chrome)).toBe("Your own Chrome on macOS, through KOS for Chrome; not KOS's browser · asks in Chrome");
    expect(describeDevice({ ...chrome, online: false, lastSeen: null })).toMatch(/Pair it from KOS for Chrome/);
  });

  it("says a phone is a phone that only chats, and asks for no grants", () => {
    const phone: PairedDevice = { ...laptop, name: "Pocket", platform: "ios", kind: "phone", os: "18.1", permissions: { screen: false, input: false } };
    expect(describeDevice(phone)).toBe("Your phone, iOS 18.1, through KOS for iPhone · chat only, no computer use · online");
    expect(describeDevice({ ...phone, online: false, lastSeen: null })).toMatch(/never connected$/);
  });

  it("gives a phone the Wi-Fi address, the code and the certificate to pin", () => {
    expect(phoneLink("https://192.168.1.20:4319", "K7QX-M2PA", "ab_c-")).toBe("kos-device://pair?url=https%3A%2F%2F192.168.1.20%3A4319&code=K7QX-M2PA&pin=ab_c-");
  });

  it("opens KOS for Mac with this dashboard's address and the code", () => {
    expect(pairingLink("http://127.0.0.1:4317", "K7QX-M2PA")).toBe("kos-device://pair?url=http%3A%2F%2F127.0.0.1%3A4317&code=K7QX-M2PA");
  });
});

describe("the Devices panel", () => {
  it("lets the owner keep work they did not start off their computers", async () => {
    vi.spyOn(api, "devices").mockResolvedValue({ devices: [laptop], settings: { askMinutes: 15, unattended: false, lan: false } });
    const set = vi.spyOn(api, "setComputerSettings").mockResolvedValue({ askMinutes: 15, unattended: true, lan: false });
    render(<DevicesPanel />);
    const toggle = await screen.findByRole("switch", { name: "Work you did not start may use a computer" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ unattended: true });
  });

  it("lists the computers and stops a session from here", async () => {
    vi.spyOn(api, "devices").mockResolvedValue({
      devices: [{ ...laptop, session: { conversation: "c", title: "Design", task: "t", until: Date.now() + 60_000, paused: false } }],
      settings: { askMinutes: 15, unattended: false, lan: false },
    });
    const stop = vi.spyOn(api, "stopDevice").mockResolvedValue({ stopped: true });
    render(<DevicesPanel />);
    expect(await screen.findByText("Studio MacBook")).toBeTruthy();
    expect(screen.getByText("in use")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledWith("dev_1");
  });

  it("makes a code to pair with, and puts it away once a computer used it", async () => {
    const devices = vi.spyOn(api, "devices").mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false, lan: false } });
    vi.spyOn(api, "deviceCode").mockResolvedValue({ code: "K7QX-M2PA", expiresAt: Date.now() + 10 * 60_000 });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DevicesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a device" }));
    expect(await screen.findByLabelText("Pairing code")).toBeTruthy();
    expect(screen.getByText("Open KOS for Mac").getAttribute("href")).toMatch(/^kos-device:\/\/pair\?url=.*&code=K7QX-M2PA$/);
    expect(screen.getByText(/Good for 10 more minutes, once/)).toBeTruthy();

    devices.mockResolvedValue({ devices: [laptop], settings: { askMinutes: 15, unattended: false, lan: false } });
    await vi.advanceTimersByTimeAsync(3_100);
    await waitFor(() => expect(screen.getByText("Paired Studio MacBook.")).toBeTruthy());
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    vi.useRealTimers();
  });

  it("keeps phones on the Wi-Fi off until the owner turns them on, then says where and what to check", async () => {
    const lan = { on: true, forced: false, port: 4319, urls: ["https://192.168.1.20:4319"], pin: "PIN", words: "4F2A 91C3 77D0 1B5E" };
    const devices = vi.spyOn(api, "devices").mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false, lan: false }, lan: { ...lan, on: false, urls: [] } });
    const set = vi.spyOn(api, "setComputerSettings").mockResolvedValue({ askMinutes: 15, unattended: false, lan: true });
    render(<DevicesPanel />);
    const toggle = await screen.findByRole("switch", { name: "Phones on this Wi-Fi" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Off by default. On, KOS for iPhone/)).toBeTruthy();
    devices.mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false, lan: true }, lan });
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ lan: true });
    expect(await screen.findByText(/https:\/\/192\.168\.1\.20:4319\. Your iPhone checks KOS shows 4F2A 91C3 77D0 1B5E/)).toBeTruthy();
  });

  it("offers a phone link with the code while phones may pair over Wi-Fi", async () => {
    vi.spyOn(api, "devices").mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false, lan: true } });
    vi.spyOn(api, "deviceCode").mockResolvedValue({
      code: "K7QX-M2PA",
      expiresAt: Date.now() + 10 * 60_000,
      lan: { url: "https://192.168.1.20:4319", urls: ["https://192.168.1.20:4319"], pin: "PIN", words: "4F2A 91C3 77D0 1B5E" },
    });
    render(<DevicesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a device" }));
    expect(await screen.findByText("4F2A 91C3 77D0 1B5E")).toBeTruthy();
    expect(screen.getByText(/enter https:\/\/192\.168\.1\.20:4319 and this code/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy phone link" })).toBeTruthy();
  });
});
