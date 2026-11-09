import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { requireServices, type ApiExtension, type AuditEntry, type BrowserElsewhere, type KosModule } from "@kos/harness";
import type { FaceDrawing } from "@kos/shared";

import { OwnerChrome } from "./chrome.js";
import { DeviceHub } from "./hub.js";
import { loadHostKey } from "./keys.js";
import { CHROME_PANEL, DevicePanel, MAC_PANEL, type PanelDeps } from "./panel.js";
import { deviceRoutes, deviceSocketServer } from "./routes.js";
import { DeviceStore } from "./store.js";
import { COMPUTER_MANIFEST, computerModule, type ComputerModule } from "./tools.js";

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
  /** The conversation calling a tool, read at call time. */
  caller(): string | undefined;
  titleOf(conversation: string): string;
  halted(): boolean;
  /** KOS's face as the owner set it, sent to every device to draw KOS by. */
  face(): FaceDrawing;
  /** The chat each device panel shows, read when it is shown: the Chrome side panel's, and the KOS for Mac window's. */
  panels: { chrome: PanelDeps; mac: PanelDeps };
  /** The audit log, for a session started unasked. */
  audit?(entry: AuditEntry): void;
  /** Stop every live turn in a chat, as the owner's Stop does; false when none was running. */
  stopTurn?(conversation: string): boolean;
}

export interface ComputerUse {
  module: KosModule;
  /** The owner's Chrome, for the kernel to send a chat's browser tools to while it works there. */
  chrome: BrowserElsewhere;
  /** The side panel of each paired Chrome, as a channel. */
  panel: DevicePanel;
  /** The chat window of each paired Mac, as a channel. */
  mac: DevicePanel;
  routes: ApiExtension;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

export function createComputerUse(options: ComputerUseOptions): ComputerUse {
  let hub: DeviceHub | undefined;
  let chrome: OwnerChrome | undefined;
  let active: ComputerModule | undefined;
  let unfaced: (() => void) | undefined;
  const sockets = deviceSocketServer(() => (active ? hub : undefined));
  const panel = new DevicePanel(CHROME_PANEL, options.panels.chrome);
  const mac = new DevicePanel(MAC_PANEL, options.panels.mac);
  // The owner leaving a chat on a device ends the session that chat holds there.
  panel.onLeave((c) => active?.left(c, "browser"));
  mac.onLeave((c) => active?.left(c, "computer"));
  // The owner's Stop on either device: the chat's turn, its sessions and its asks end.
  panel.onStop((c) => active?.stopped(c));
  mac.onStop((c) => active?.stopped(c));

  const module: KosModule = {
    manifest: COMPUTER_MANIFEST,
    async activate(ctx) {
      // Made on first activation, when the store exists; kept across a switch
      // off and on so the devices' connections are the only thing that resets.
      hub ??= new DeviceHub({
        store: new DeviceStore(requireServices(ctx).db),
        hostKey: loadHostKey({ path: options.hostKeyPath, ...(options.hostKeyEnv ? { env: options.hostKeyEnv } : {}) }),
        halted: options.halted,
        face: options.face,
      });
      chrome ??= new OwnerChrome(hub);
      panel.attach(hub);
      mac.attach(hub);
      const events = ctx.events;
      unfaced = events?.on("face:changed", () => hub?.tellFace());
      active = computerModule({
        hub,
        chrome,
        caller: options.caller,
        titleOf: options.titleOf,
        ...(options.audit ? { audit: options.audit } : {}),
        ...(options.stopTurn ? { stopTurn: options.stopTurn } : {}),
        // The KOS for Mac window's chat set to Ask: each step on the screen asks first.
        asksEachStep: (conversation) => mac.deviceOf(conversation) !== undefined && !(options.panels.mac.auto?.(conversation) ?? false),
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
    },
    async deactivate() {
      await active?.deactivate?.();
      active = undefined;
      unfaced?.();
      unfaced = undefined;
      panel.attach(undefined);
      mac.attach(undefined);
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
  };

  return {
    module,
    chrome: elsewhere,
    panel,
    mac,
    routes: deviceRoutes(() => (active ? hub : undefined), options.titleOf),
    upgrade: (req, socket, head) => sockets.upgrade(req, socket, head),
    close() {
      hub?.closeAll();
      sockets.close();
    },
  };
}
