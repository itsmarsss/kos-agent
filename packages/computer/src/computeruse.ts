import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { requireServices, SecretUses, type ApiExtension, type ApprovalRequest, type AuditEntry, type BrowserElsewhere, type KosModule, type ModuleContext, type VaultDevices } from "@kos/harness";
import type { DashboardTheme, FaceDrawing } from "@kos/shared";

import type { Build, BuildKind } from "./builds.js";
import { OwnerChrome, type PageSecrets } from "./chrome.js";
import { DeviceHub } from "./hub.js";
import { loadHostKey, loadLocalKey } from "./keys.js";
import type { ApnsSender } from "./apns.js";
import { DeviceLan, type LanOptions } from "./lan.js";
import { MacVault, unlockAtLogin } from "./macvault.js";
import { CHROME_PANEL, DevicePanel, MAC_PANEL, PHONE_PANEL, type PanelDeps } from "./panel.js";
import { PhonePush, pushConfig, type ApnsEnv } from "./push.js";
import { deviceRoutes, deviceSocketServer } from "./routes.js";
import { DeviceStore } from "./store.js";
import { COMPUTER_MANIFEST, computerModule, type ComputerModule } from "./tools.js";
import { DeviceUpdates, type MacInstaller } from "./updates.js";

/**
 * Computer use, as one thing a host plugs in: a module for the kernel to
 * load, routes for the dashboard server, the device socket for its
 * upgrades, and the chats drawn on devices (the Chrome side panel, KOS
 * Device's window) as surfaces to connect. The kernel
 * knows none of it; switched off in Settings, the module takes its tools
 * back, ends every session, the panels go quiet and the routes say so.
 */

export interface ComputerUseOptions {
  /** Where KOS's own key is kept when the environment does not give one. Outside the workspace. */
  hostKeyPath: string;
  /** KOS's key as base64 PKCS#8, for a host whose home does not persist. */
  hostKeyEnv?: string;
  /** Where the secret a KOS for Mac on this computer proves it is here with is kept; none, and no Mac is taken as here. */
  localKeyPath?: string;
  /** Told each key once it is loaded, as base64, so it is scrubbed should it ever come back in a result. */
  watchKey?: (name: "device_host_key" | "device_local_key" | "apns_key", value: string) => void;
  /** The conversation calling a tool, read at call time. */
  caller(): string | undefined;
  /** The owner's secrets as the pages of their Chrome need them: cleaned from what KOS reads, masked in pictures, no script on a credential site. */
  pageSecrets?: PageSecrets;
  titleOf(conversation: string): string;
  halted(): boolean;
  /** KOS's face as the owner set it, sent to every device to draw KOS by. */
  face(): FaceDrawing;
  /** The dashboard's theme and the palette it was last drawn in, sent to every device to follow unless it keeps its own. */
  theme(): DashboardTheme;
  /** The chat each device panel shows, read when it is shown: the Chrome side panel's, the KOS for Mac window's, and KOS for iPhone's. */
  panels: { chrome: PanelDeps; mac: PanelDeps; phone: PanelDeps };
  /** The listener phones on the home Wi-Fi reach the device socket through; off unless the owner turns it on. */
  lan?: LanOptions;
  /** Asks pushed to the owner's iPhones: the APNs key from the host's environment, if it gives one (else Settings'), and who sends. */
  push?: { env?: ApnsEnv; sender?: ApnsSender; log?(line: string): void };
  /** The audit log, for a session started unasked. */
  audit?(entry: AuditEntry): void;
  /** Stop every live turn in a chat, as the owner's Stop does; false when none was running. */
  stopTurn?(conversation: string): boolean;
  /** KOS's own addresses (host, or host:port): its dashboard, on which no secret is typed. */
  ownHosts?(): readonly string[];
  /** Keeping the device apps on KOS's build: what it would hand each, and how KOS for Mac is rebuilt here. None, and nothing is compared. */
  updates?: {
    expected(kind: BuildKind): Build | undefined;
    mac?: MacInstaller;
    /** An update that did not take, kept until the device is current: the owner's Inbox. */
    health?(key: string, label: string, ok: boolean, error: string | null): void;
    log?(line: string): void;
  };
}

export interface ComputerUse {
  module: KosModule;
  /** The owner's Chrome, for the kernel to send a chat's browser tools to while it works there. */
  chrome: BrowserElsewhere;
  /** What the owner has paired, one line each, while computer use is on; nothing while it is off. */
  paired(): string | undefined;
  /** Why a yes on a secret's ask from this device, or from the dashboard, may be KOS's own hand (DeviceHub.handsOn). */
  handsOn(device: string | undefined, conversation: string | null): string | undefined;
  /** The side panel of each paired Chrome, as a channel. */
  panel: DevicePanel;
  /** The chat window of each paired Mac, as a channel. */
  mac: DevicePanel;
  /** The chat of each paired phone, as a channel. */
  phone: DevicePanel;
  /** A new ask, pushed to each paired phone that gave KOS a token, once push has an APNs key. */
  push: { asked(req: ApprovalRequest): void };
  /** The KOS for Mac on this computer, for the vault's device slot (macvault.ts). */
  vaultDevices: VaultDevices;
  routes: ApiExtension;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
}

/**
 * A chat's computer session told when its turn waits on the owner for an
 * approval, and when it no longer does, however the ask settled (decided,
 * lapsed, or let go by a turn that stopped waiting): the device says so on
 * its bar and in its menu bar, whichever chat its window shows. `waiting` is
 * whether a chat has an ask open, which each step's status says too.
 */
export function tellWaits(events: NonNullable<ModuleContext["events"]>, hub: Pick<DeviceHub, "tellStatus">): { off: () => void; waiting: (chat: string) => boolean } {
  /** Approvals asked and not yet settled, by id, with the chat each is for. */
  const asked = new Map<number, string>();
  const waiting = (chat: string): boolean => [...asked.values()].includes(chat);
  const offs = [
    events.on("approval:requested", (e) => {
      if (!e.conversationId) return;
      asked.set(e.id, e.conversationId);
      hub.tellStatus(e.conversationId, { waiting: true });
    }),
    events.on("approval:decided", (e) => {
      const chat = asked.get(e.id);
      if (chat === undefined) return;
      asked.delete(e.id);
      hub.tellStatus(chat, { waiting: waiting(chat) });
    }),
  ];
  return { off: () => offs.forEach((off) => off()), waiting };
}

export function createComputerUse(options: ComputerUseOptions): ComputerUse {
  let store: DeviceStore | undefined;
  let localKey: Buffer | undefined;
  let localProblem: string | undefined;
  let hub: DeviceHub | undefined;
  let updates: DeviceUpdates | undefined;
  let chrome: OwnerChrome | undefined;
  let active: ComputerModule | undefined;
  let unfaced: (() => void) | undefined;
  let unthemed: (() => void) | undefined;
  let unmoded: (() => void) | undefined;
  let waits: ReturnType<typeof tellWaits> | undefined;
  let secretUses: SecretUses | undefined;
  let push: PhonePush | undefined;
  let unpushed: (() => void) | undefined;
  let unlocking: (() => void) | undefined;
  const sockets = deviceSocketServer(() => (active ? hub : undefined));
  const panel = new DevicePanel(CHROME_PANEL, options.panels.chrome);
  const mac = new DevicePanel(MAC_PANEL, options.panels.mac);
  const phone = new DevicePanel(PHONE_PANEL, options.panels.phone);
  const lan = options.lan ? new DeviceLan(() => (active ? hub : undefined), options.lan) : undefined;
  const vaultDevices = new MacVault(() => (active ? hub : undefined));
  // The owner leaving a chat on a device ends the session that chat holds there.
  panel.onLeave((c) => active?.left(c, "browser"));
  mac.onLeave((c) => active?.left(c, "computer"));
  // The owner's Stop on either device: the chat's turn, its sessions and its asks end.
  panel.onStop((c) => active?.stopped(c));
  mac.onStop((c) => active?.stopped(c));
  // A phone holds no session, so leaving a chat there ends nothing; its Stop stops the turn as the others' do.
  phone.onStop((c) => active?.stopped(c));

  const module: KosModule = {
    manifest: COMPUTER_MANIFEST,
    async activate(ctx) {
      // Made on first activation, when the store exists; kept across a switch
      // off and on so the devices' connections are the only thing that resets.
      store ??= new DeviceStore(requireServices(ctx).db);
      const { secrets } = requireServices(ctx);
      // A secret that will not read stops only KOS rebuilding the Mac on its own, never computer use.
      if (options.localKeyPath && !localKey && !localProblem) {
        try {
          localKey = loadLocalKey(options.localKeyPath);
          options.watchKey?.("device_local_key", localKey.toString("base64"));
        } catch (err) {
          localProblem = `KOS can't tell this Mac is its own: remove ${options.localKeyPath} and KOS makes another`;
          (options.updates?.log ?? ((line: string) => console.error(line)))(`devices: ${localProblem} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (!hub) {
        const hostKey = loadHostKey({ path: options.hostKeyPath, ...(options.hostKeyEnv ? { env: options.hostKeyEnv } : {}) });
        options.watchKey?.("device_host_key", hostKey.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
        hub = new DeviceHub({
          store,
          hostKey,
          halted: options.halted,
          face: options.face,
          theme: options.theme,
          ...(localKey ? { localKey } : {}),
          ...(options.ownHosts ? { ownHosts: options.ownHosts } : {}),
          scrub: (text) => secrets.scrub(text),
        });
      }
      const devices = hub;
      if (!push) {
        const env = options.push?.env;
        // A key given in the environment is the host's own: scrubbed should it ever come back in a result.
        if (env?.key) options.watchKey?.("apns_key", env.key.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s+/g, ""));
        const kept = store;
        push = new PhonePush({
          store: kept,
          hub: devices,
          // Read at each send: Settings may name another key, and the vault may have opened or shut.
          config: () => pushConfig(env, kept.pushSettings(), (handle) => (secrets.inVault(handle) ? secrets.get(handle) : undefined)),
          scrub: (text) => secrets.scrub(text),
          ...(options.push?.sender ? { sender: options.push.sender } : {}),
          ...(options.push?.log ? { log: options.push.log } : {}),
        });
      }
      if (options.updates && !updates) {
        const { expected, mac: installer, health, log } = options.updates;
        updates = new DeviceUpdates({
          hub: devices,
          store,
          expected,
          ...(installer ? { mac: installer } : {}),
          // Its window holds no session or ask, and no turn runs in the Mac's chats.
          idle: (device) => !devices.inUse(device) && !mac.busy(),
          ...(localProblem ? { localProblem } : {}),
          ...(options.audit ? { audit: options.audit } : {}),
          ...(health ? { health } : {}),
          ...(log ? { log } : {}),
        });
        mac.onSettled(() => updates?.poke());
      }
      updates?.start();
      chrome ??= new OwnerChrome(hub, options.pageSecrets);
      panel.attach(hub);
      mac.attach(hub);
      phone.attach(hub);
      const events = ctx.events;
      unfaced = events?.on("face:changed", () => hub?.tellFace());
      unthemed = events?.on("theme:changed", () => hub?.tellTheme());
      unmoded = events?.on("chat:mode", (e) => [panel, mac, phone].forEach((p) => p.modeChanged(e.conversationId)));
      waits = events ? tellWaits(events, devices) : undefined;
      // Settled anywhere, however it settled: the phones it was pushed to take it down.
      unpushed = events?.on("approval:decided", (e) => void push?.settled(String(e.id)));
      // A vault a Mac here opens at login is opened as soon as that Mac connects.
      const vault = secrets.attached();
      const log = options.updates?.log ?? ((line: string) => console.error(line));
      unlocking = vault ? unlockAtLogin({ vault, hub: devices, macs: vaultDevices, log }) : undefined;
      active = computerModule({
        hub,
        chrome,
        caller: options.caller,
        titleOf: options.titleOf,
        ...(options.audit ? { audit: options.audit } : {}),
        ...(options.stopTurn ? { stopTurn: options.stopTurn } : {}),
        // The owner's vault, read at each use, and its record of uses: secrets.type on a Mac.
        secrets: {
          vault: () => secrets.attached(),
          uses: (secretUses ??= new SecretUses(requireServices(ctx).db)),
          tellOwner: (text) => void requireServices(ctx).notify?.({ text, target: { kind: "owner" } }).catch(() => undefined),
          ...(options.ownHosts ? { ownHosts: options.ownHosts } : {}),
          codes: () => requireServices(ctx).secrets.codes,
        },
        // What a read of the owner's clipboard brings in, and its card's preview, masked as any tool result is.
        scrub: (text) => secrets.scrub(text),
        // The KOS for Mac window's chat set to Ask: each step on the screen asks first.
        asksEachStep: (conversation) => mac.asksEachStep(conversation),
        inAuto: (conversation) => mac.inAuto(conversation),
        waitingOn: (conversation) => waits?.waiting(conversation) ?? false,
        panelChrome: (conversation) => panel.deviceOf(conversation),
        panelMac: (conversation) => {
          const device = mac.deviceOf(conversation);
          const app = mac.appOf(conversation);
          return device ? { device, ...(app ? { app } : {}) } : undefined;
        },
        ...(events
          ? {
              onHalt: (handler: () => void) => events.on("halt:changed", (e) => (e.halted ? handler() : undefined)),
              onStop: (handler: (conversation: string) => void) => events.on("turn:stop", (e) => handler(e.conversationId)),
              onFresh: (handler: (conversation: string) => void) => {
                const offs = [events.on("turn:start", (e) => handler(e.conversationId)), events.on("query:fresh", (e) => handler(e.conversationId))];
                return () => offs.forEach((off) => off());
              },
              onTurnEnd: (handler: (conversation: string) => void) => events.on("turn:end", (e) => handler(e.conversationId)),
              onHeard: (handler: (conversation: string) => void) => events.on("turn:heard", (e) => handler(e.conversationId)),
            }
          : {}),
      });
      await active.activate(ctx);
      await lan?.sync(hub.settings().lan);
    },
    async deactivate() {
      await active?.deactivate?.();
      active = undefined;
      updates?.stop();
      unfaced?.();
      unfaced = undefined;
      unthemed?.();
      unthemed = undefined;
      unmoded?.();
      unmoded = undefined;
      waits?.off();
      waits = undefined;
      unpushed?.();
      unpushed = undefined;
      unlocking?.();
      unlocking = undefined;
      panel.attach(undefined);
      mac.attach(undefined);
      phone.attach(undefined);
      await lan?.sync(false);
      hub?.closeAll();
    },
  };

  // Before the module is active there is no session, so no chat is in the owner's Chrome.
  const elsewhere: BrowserElsewhere = {
    active: (c) => (active && chrome ? chrome.active(c) : false),
    // The side panel's chat browses in the owner's Chrome even before its session starts: never in KOS's own.
    claims: (c) => active !== undefined && panel.deviceOf(c) !== undefined,
    ensure: async (c, signal) => {
      if (!active) throw new Error("Computer use is off, so the owner's Chrome cannot be reached; KOS's own browser is not used for the side panel's chat.");
      await active.beginPanelChrome(c, signal);
    },
    tab: (c) => chrome!.tab(c),
    tabs: (c) => chrome?.tabs(c) ?? [],
    tabsOf: (c) => chrome?.tabsOf(c) ?? [],
    useTab: (c, t) => chrome!.useTab(c, t),
    newTab: (c) => chrome!.newTab(c),
    spot: (c) => chrome?.spot(c),
    siteOf: (c) => chrome?.siteOf(c),
    actsAlone: (c, site) => chrome?.actsAlone(c, site) ?? false,
    picture: async (c, w) => chrome?.picture(c, w),
    describe: (c) => chrome?.describe(c) ?? "the owner's Chrome",
    device: (c) => {
      const device = chrome?.deviceOf(c);
      return device ? { id: device.id, name: device.name } : undefined;
    },
  };

  return {
    module,
    chrome: elsewhere,
    paired: () => active?.paired(),
    handsOn: (device, conversation) => hub?.handsOn(device, conversation),
    panel,
    mac,
    phone,
    push: { asked: (req) => void (active ? push?.asked(req) : undefined) },
    vaultDevices,
    routes: deviceRoutes(() => (active ? hub : undefined), options.titleOf, lan, () => (active ? updates : undefined), () => (active ? push : undefined)),
    upgrade: (req, socket, head) => sockets.upgrade(req, socket, head),
    async close() {
      hub?.closeAll();
      push?.close();
      sockets.close();
      await lan?.close();
    },
  };
}
