import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { requireServices, type ApiExtension, type BrowserElsewhere, type KosModule } from "@kos/harness";

import { OwnerChrome } from "./chrome.js";
import { DeviceHub } from "./hub.js";
import { loadHostKey } from "./keys.js";
import { deviceRoutes, deviceSocketServer } from "./routes.js";
import { DeviceStore } from "./store.js";
import { COMPUTER_MANIFEST, computerModule } from "./tools.js";

/**
 * Computer use, as one thing a host plugs in: a module for the kernel to
 * load, routes for the dashboard server, and the device socket for its
 * upgrades. The kernel knows none of it; switched off in Settings, the
 * module takes its tools back, ends every session and the routes say so.
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
}

export interface ComputerUse {
  module: KosModule;
  /** The owner's Chrome, for the kernel to send a chat's browser tools to while it works there. */
  chrome: BrowserElsewhere;
  routes: ApiExtension;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

export function createComputerUse(options: ComputerUseOptions): ComputerUse {
  let hub: DeviceHub | undefined;
  let chrome: OwnerChrome | undefined;
  let active: KosModule | undefined;
  const sockets = deviceSocketServer(() => (active ? hub : undefined));

  const module: KosModule = {
    manifest: COMPUTER_MANIFEST,
    async activate(ctx) {
      // Made on first activation, when the store exists; kept across a switch
      // off and on so the devices' connections are the only thing that resets.
      hub ??= new DeviceHub({
        store: new DeviceStore(requireServices(ctx).db),
        hostKey: loadHostKey({ path: options.hostKeyPath, ...(options.hostKeyEnv ? { env: options.hostKeyEnv } : {}) }),
        halted: options.halted,
      });
      chrome ??= new OwnerChrome(hub);
      const events = ctx.events;
      active = computerModule({
        hub,
        chrome,
        caller: options.caller,
        titleOf: options.titleOf,
        ...(events ? { onHalt: (handler: () => void) => events.on("halt:changed", (e) => (e.halted ? handler() : undefined)) } : {}),
      });
      await active.activate(ctx);
    },
    async deactivate() {
      await active?.deactivate?.();
      active = undefined;
      hub?.closeAll();
    },
  };

  // Before the module is active there is no session, so no chat is in the owner's Chrome.
  const elsewhere: BrowserElsewhere = {
    active: (c) => (active && chrome ? chrome.active(c) : false),
    tab: (c) => chrome!.tab(c),
    tabs: (c) => chrome?.tabs(c) ?? [],
    tabsOf: (c) => chrome?.tabsOf(c) ?? [],
    useTab: (c, t) => chrome!.useTab(c, t),
    newTab: (c) => chrome!.newTab(c),
    siteOf: (c) => chrome?.siteOf(c),
    picture: async (c, w) => chrome?.picture(c, w),
    describe: (c) => chrome?.describe(c) ?? "the owner's Chrome",
  };

  return {
    module,
    chrome: elsewhere,
    routes: deviceRoutes(() => (active ? hub : undefined), options.titleOf),
    upgrade: (req, socket, head) => sockets.upgrade(req, socket, head),
    close() {
      hub?.closeAll();
      sockets.close();
    },
  };
}
