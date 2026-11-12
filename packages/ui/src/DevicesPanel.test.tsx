// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type PairedDevice } from "./api.js";
import { buildWords, canUpdate, describeDevice, DevicesPanel, pairingLink, phoneLink, updateWords } from "./DevicesPanel.js";

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

describe("a device's build, in words", () => {
  const build = { id: "0123456789ab", commit: "b".repeat(40) };
  const chrome: PairedDevice = { ...laptop, name: "Chrome", platform: "chrome", kind: "browser", local: true, build: { ...build, id: "000000000001", commit: "a".repeat(40), builtAt: 1_000 } };

  it("names the commit that built it and when, or says it is not known", () => {
    expect(buildWords({ ...build, builtAt: 1_000 }, 1_000 + 2 * 3_600_000)).toBe("Build bbbbbbb, built 2h ago");
    expect(buildWords({ id: "0123456789ab", commit: "" })).toBe("Build 0123456789ab");
    expect(buildWords(undefined)).toBe("Build unknown");
  });

  it("says where it stands with KOS's and why, and when Update now can do anything", () => {
    expect(updateWords({ ...chrome, update: { state: "current", build } })).toEqual({ pill: "Up to date", tone: "ok" });
    const behind = { ...chrome, update: { state: "behind" as const, build, reason: "idle" as const } };
    expect(updateWords(behind)).toEqual({ pill: "Behind", tone: "warn", why: "Reloads once its side panel is idle" });
    expect(canUpdate(behind)).toBe(true);
    const mac = { ...laptop, local: true, update: { state: "behind" as const, build, reason: "signing" as const, command: "cd app && scripts/signing.sh setup" } };
    expect(updateWords(mac)?.why).toMatch(/Signing is not set up/);
    expect(canUpdate(mac)).toBe(true);
    expect(updateWords({ ...mac, update: { state: "updating", build } })).toMatchObject({ pill: "Updating", tone: "accent" });
    const phone: PairedDevice = { ...laptop, kind: "phone", platform: "ios", update: { state: "behind", build, reason: "xcode" } };
    expect(updateWords(phone)?.why).toBe("Run KOS for iPhone again from Xcode on your Mac");
    expect(canUpdate(phone)).toBe(false);
    const store = { ...chrome, update: { state: "behind" as const, build, reason: "store" as const } };
    expect(updateWords(store)?.why).toBe("Installed from the store; Chrome updates it");
    expect(canUpdate(store)).toBe(false);
    expect(canUpdate({ ...behind, update: { ...behind.update, reason: "remote" } })).toBe(false);
    expect(canUpdate({ ...behind, online: false })).toBe(false);
    // A KOS for Mac from before stamps can be rebuilt here; a Chrome from before them cannot hear KOS's word.
    const unknown = { state: "unknown" as const, build, reason: "unstamped" as const };
    expect(canUpdate({ ...mac, update: unknown })).toBe(true);
    expect(canUpdate({ ...chrome, update: unknown })).toBe(false);
    expect(updateWords({ ...mac, update: { state: "behind", build, reason: "failed", detail: "errSecInternalComponent" } })?.why).toBe("The update did not finish: errSecInternalComponent");
  });
});

describe("the Devices panel", () => {
  it("lets the owner keep work they did not start off their computers", async () => {
    vi.spyOn(api, "devices").mockResolvedValue({ devices: [laptop], settings: { askMinutes: 15, unattended: false, lan: false, autoUpdate: true } });
    const set = vi.spyOn(api, "setComputerSettings").mockResolvedValue({ askMinutes: 15, unattended: true, lan: false, autoUpdate: true });
    render(<DevicesPanel />);
    const toggle = await screen.findByRole("switch", { name: "Work you did not start may use a computer" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ unattended: true });
  });

  it("lists the computers and stops a session from here", async () => {
    vi.spyOn(api, "devices").mockResolvedValue({
      devices: [{ ...laptop, session: { conversation: "c", title: "Design", task: "t", until: Date.now() + 60_000, paused: false } }],
      settings: { askMinutes: 15, unattended: false, lan: false, autoUpdate: true },
    });
    const stop = vi.spyOn(api, "stopDevice").mockResolvedValue({ stopped: true });
    render(<DevicesPanel />);
    expect(await screen.findByText("Studio MacBook")).toBeTruthy();
    expect(screen.getByText("in use")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledWith("dev_1");
  });

  it("makes a code to pair with, and puts it away once a computer used it", async () => {
    const devices = vi.spyOn(api, "devices").mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false, lan: false, autoUpdate: true } });
    vi.spyOn(api, "deviceCode").mockResolvedValue({ code: "K7QX-M2PA", expiresAt: Date.now() + 10 * 60_000 });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DevicesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a device" }));
    expect(await screen.findByLabelText("Pairing code")).toBeTruthy();
    expect(screen.getByText("Open KOS for Mac").getAttribute("href")).toMatch(/^kos-device:\/\/pair\?url=.*&code=K7QX-M2PA$/);
    expect(screen.getByText(/Good for 10 more minutes, once/)).toBeTruthy();

    devices.mockResolvedValue({ devices: [laptop], settings: { askMinutes: 15, unattended: false, lan: false, autoUpdate: true } });
    await vi.advanceTimersByTimeAsync(3_100);
    await waitFor(() => expect(screen.getByText("Paired Studio MacBook.")).toBeTruthy());
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    vi.useRealTimers();
  });

  it("keeps phones on the Wi-Fi off until the owner turns them on, then says where and what to check", async () => {
    const lan = { on: true, forced: false, port: 4319, urls: ["https://192.168.1.20:4319"], pin: "PIN", words: "4F2A 91C3 77D0 1B5E" };
    const devices = vi.spyOn(api, "devices").mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false, lan: false, autoUpdate: true }, lan: { ...lan, on: false, urls: [] } });
    const set = vi.spyOn(api, "setComputerSettings").mockResolvedValue({ askMinutes: 15, unattended: false, lan: true, autoUpdate: true });
    render(<DevicesPanel />);
    const toggle = await screen.findByRole("switch", { name: "Phones on this Wi-Fi" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Off by default. On, KOS for iPhone/)).toBeTruthy();
    // Said before it is on, and while it is: the pairing page is the whole network's.
    expect(screen.getByText(/leave it off on a shared network/)).toBeTruthy();
    devices.mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false, lan: true, autoUpdate: true }, lan });
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ lan: true });
    expect(await screen.findByText(/https:\/\/192\.168\.1\.20:4319\. Your iPhone checks KOS shows 4F2A 91C3 77D0 1B5E/)).toBeTruthy();
    expect(screen.getByText(/Anyone on the same Wi-Fi can reach its pairing page/)).toBeTruthy();
  });

  it("shows each device's build and where it stands, updates one now, and keeps the setting", async () => {
    const build = { id: "0123456789ab", commit: "b".repeat(40) };
    const mac: PairedDevice = {
      ...laptop,
      local: true,
      build: { id: "000000000001", commit: "a".repeat(40), builtAt: Date.now() - 3 * 3_600_000 },
      update: { state: "behind", build, reason: "signing", command: "cd app && scripts/signing.sh setup" },
    };
    const phone: PairedDevice = { ...laptop, id: "dev_2", name: "Pocket", kind: "phone", platform: "ios", update: { state: "behind", build, reason: "xcode" } };
    vi.spyOn(api, "devices").mockResolvedValue({ devices: [mac, phone], settings: { askMinutes: 15, unattended: false, lan: false, autoUpdate: true } });
    const update = vi.spyOn(api, "updateDevice").mockResolvedValue({ update: { state: "updating", build } });
    const set = vi.spyOn(api, "setComputerSettings").mockResolvedValue({ askMinutes: 15, unattended: false, lan: false, autoUpdate: false });
    render(<DevicesPanel />);
    expect(await screen.findByText(/Build aaaaaaa, built 3h ago · Signing is not set up/)).toBeTruthy();
    // The command is outside the row's press: selecting it, or Copy, does not open or close the row.
    const command = screen.getByText("cd app && scripts/signing.sh setup");
    expect(command.closest("button")).toBeNull();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByRole("button", { name: "Copy the command" }));
    expect(writeText).toHaveBeenCalledWith("cd app && scripts/signing.sh setup");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getAllByText("Behind")).toHaveLength(2);
    expect(screen.getByText(/Run KOS for iPhone again from Xcode/)).toBeTruthy();
    // Only the Mac can be updated from here; the phone is the owner's to run from Xcode.
    expect(screen.getAllByRole("button", { name: /^Update (now|anyway)$/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Update anyway" }));
    expect(update).toHaveBeenCalledWith("dev_1");
    const toggle = screen.getByRole("switch", { name: "Update devices on their own" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ autoUpdate: false });
  });

  it("offers a phone link with the code while phones may pair over Wi-Fi", async () => {
    vi.spyOn(api, "devices").mockResolvedValue({ devices: [], settings: { askMinutes: 15, unattended: false, lan: true, autoUpdate: true } });
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
