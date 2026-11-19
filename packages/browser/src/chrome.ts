import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";

/**
 * The one Chrome.
 *
 * KOS runs a single browser and every agent works in a tab of it: a tab is
 * cheap and a browser is not, and one browser means one set of logins, one
 * window to watch, one thing to keep alive. KOS owns it so that it is
 * there before an agent wants it, is found again after it crashes, and
 * dies with the host rather than lingering.
 *
 * Headless by default (the dashboard is the window), with every tab in a
 * window of its own: Chrome paints only a window's front tab, so two tabs in
 * one window would mean one agent's page going dark while the other works.
 */

/** How to start it. Read at each launch, so a changed setting applies on the next one. */
export interface ChromeLaunch {
  /** A binary to use instead of the first one found. */
  binary?: string;
  /** Show the window on the machine as well. */
  headed?: boolean;
  /** Each tab's window. The page is this size less the window's own frame. */
  windowSize?: { width: number; height: number };
  /**
   * Unpacked extension folders. Loaded over the protocol once Chrome is up,
   * since Google Chrome 137 and later ignores --load-extension; the launch
   * only allows that.
   */
  extensions?: string[];
  /**
   * A Chrome that draws what KOS did not write (artifacts.check, an
   * export), cut off from the network at its own resolver and proxy: no
   * name resolves, and every connection, a preconnect or a navigation's
   * included, goes to a proxy that is not there, but those to the loopback
   * ports named here, KOS's own. Never KOS's browser for the web, which
   * needs the network.
   */
  sealed?: { loopback: number[] };
}

/** Where a sealed Chrome's every connection goes: the discard port on loopback, where nothing answers. */
export const BLACK_HOLE = "127.0.0.1:9";

/** The flags that cut a sealed Chrome off: a resolver that finds no name, and a proxy that is not there for all but KOS's own ports. */
export function sealedArgs(sealed: { loopback: number[] }): string[] {
  return [
    // No name resolves, so no lookup leaves the machine with what a page put in a host name.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    // Every connection goes to the proxy, loopback too (<-loopback), but KOS's own ports.
    `--proxy-server=${BLACK_HOLE}`,
    `--proxy-bypass-list=${["<-loopback>", ...sealed.loopback.map((port) => `127.0.0.1:${port}`)].join(";")}`,
  ];
}

export interface ChromeOptions {
  /** The DevTools port. Fixed, so a Chrome left running is found again on it. */
  port: number;
  /** Where cookies, logins and installed extensions live between runs. */
  profileDir: string;
  launch?: () => ChromeLaunch;
  /** Test seams. */
  spawn?: typeof nodeSpawn;
  fetchJson?: (url: string) => Promise<Record<string, unknown>>;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
}

export type ChromeState = "stopped" | "starting" | "running";

/** Where a Chrome usually is, first match wins. */
const KNOWN_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/**
 * A Chrome to run: the one named, else the first known one that exists.
 * KOS_CHROME=none finds none, as a machine without Chrome would (CI, or a
 * run of the tests that checks KOS behaves without one).
 */
export function findChrome(preferred: string | undefined, exists: (p: string) => boolean = existsSync): string | undefined {
  if (process.env.KOS_CHROME === "none") return undefined;
  if (preferred && exists(preferred)) return preferred;
  return KNOWN_BINARIES.find((p) => exists(p));
}

/** The command line, for the record and the tests. */
export function chromeArgs(options: Pick<ChromeOptions, "port" | "profileDir"> & ChromeLaunch): string[] {
  const size = options.windowSize ?? { width: 1600, height: 1000 };
  const extensions = (options.extensions ?? []).filter(Boolean);
  return [
    ...(options.headed ? [] : ["--headless=new"]),
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.profileDir}`,
    `--window-size=${size.width},${size.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Under a stand-in HOME (tests, scratch hosts) macOS finds no keychain for
    // Chrome's cookie key and asks the owner where to keep it; a mock one asks nothing.
    ...(homedir() === userInfo().homedir ? [] : ["--use-mock-keychain"]),
    // A tab in its own window is never backgrounded, but belt and braces:
    // nothing a page runs should slow because KOS is not looking at it.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=TranslateUI",
    // Lets KOS load the extensions over CDP (Extensions.loadUnpacked).
    ...(extensions.length ? ["--enable-unsafe-extension-debugging"] : []),
    ...(options.sealed ? sealedArgs(options.sealed) : []),
    "about:blank",
  ];
}

const defaultFetchJson = async (url: string): Promise<Record<string, unknown>> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};

/** How long a launch may take to answer on its port. */
const LAUNCH_MS = 15_000;
/** How long a Chrome told to close may take to stop answering. */
const GONE_MS = 5_000;
/** How long a Chrome sent SIGTERM has before it is killed. */
const STOP_GRACE_MS = 3_000;

/** Whether a child has exited: its code is set, or the signal that ended it. */
const ended = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/** Until a child has exited, or failed to start. */
const exitOf = (child: ChildProcess): Promise<void> =>
  ended(child)
    ? Promise.resolve()
    : new Promise((resolve) => {
        child.once("exit", () => resolve());
        // One that could not be started never exits.
        child.once("error", () => resolve());
      });

/**
 * A signal to a child's whole process group: it was spawned detached, so the
 * group is its own and its pid names it. A child without a pid (one that
 * never started) is signalled alone.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

export class ChromeHost {
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private wsUrl: string | null = null;
  private readonly exitListeners = new Set<() => void>();

  constructor(private readonly options: ChromeOptions) {}

  get state(): ChromeState {
    if (this.wsUrl) return "running";
    if (this.starting) return "starting";
    return "stopped";
  }

  get port(): number {
    return this.options.port;
  }

  /** The launch as it would be now: what the settings say, and the binary they resolve to. */
  get launch(): ChromeLaunch & { found?: string } {
    const launch = this.options.launch?.() ?? {};
    const found = findChrome(launch.binary, this.options.exists);
    return { ...launch, ...(found ? { found } : {}) };
  }

  /** Told when the browser process ends. */
  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * The browser endpoint, starting Chrome if nothing answers on the port.
   * A Chrome already there (the last host's, or one started by hand with
   * the same port) is adopted rather than fought.
   */
  async ensure(): Promise<string> {
    if (this.wsUrl) return this.wsUrl;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Forget the endpoint: the next ensure() checks the port again. */
  lost(): void {
    this.wsUrl = null;
  }

  /**
   * Stop the Chrome KOS started, and every process it started. The browser
   * alone is asked first: it closes its helpers itself, and a SIGTERM to its
   * network service would cut off the cookies it is still writing. If it has
   * not gone within the grace period, its whole process group (renderers, GPU
   * process and all) is killed. Resolves once the browser has exited, so its
   * profile can be deleted without Chrome still writing to it. An adopted
   * Chrome is left be.
   */
  stop(graceMs = STOP_GRACE_MS): Promise<void> {
    const child = this.child;
    this.child = null;
    this.wsUrl = null;
    if (!child) return Promise.resolve();
    const exited = exitOf(child);
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const kill = setTimeout(() => signalGroup(child, "SIGKILL"), graceMs);
    return exited.then(() => {
      clearTimeout(kill);
      // A helper that outlived the browser goes with it.
      signalGroup(child, "SIGKILL");
    });
  }

  /**
   * Until the Chrome KOS started has exited, so what it writes as it closes
   * (its cookies among it) is on disk before KOS goes. One KOS adopted is
   * not its child, so for that one, until nothing answers on the port.
   */
  async waitExit(ms = GONE_MS): Promise<void> {
    const child = this.child;
    if (!child || ended(child)) return this.waitGone();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Until nothing answers on the port, so a restart does not adopt the
   * Chrome on its way out. An adopted Chrome is not KOS's child, so this
   * is the only way to know it has gone.
   */
  async waitGone(): Promise<void> {
    const probe = this.options.fetchJson ?? defaultFetchJson;
    const version = `http://127.0.0.1:${this.options.port}/json/version`;
    const deadline = Date.now() + GONE_MS;
    while (Date.now() < deadline) {
      const answer = await probe(version).catch(() => null);
      if (!answer) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private async start(): Promise<string> {
    const probe = this.options.fetchJson ?? defaultFetchJson;
    const version = `http://127.0.0.1:${this.options.port}/json/version`;
    const found = await probe(version).catch(() => null);
    if (found && typeof found["webSocketDebuggerUrl"] === "string") {
      this.wsUrl = found["webSocketDebuggerUrl"];
      return this.wsUrl;
    }
    const launch = this.options.launch?.() ?? {};
    const binary = findChrome(launch.binary, this.options.exists);
    if (!binary) throw new Error("no Chrome found; name its path under Settings > Browser");
    mkdirSync(this.options.profileDir, { recursive: true });
    const spawn = this.options.spawn ?? nodeSpawn;
    const child = spawn(binary, chromeArgs({ port: this.options.port, profileDir: this.options.profileDir, ...launch }), {
      stdio: "ignore",
      env: this.options.env ?? process.env,
      // Its own process group, so stop() reaches the helpers Chrome starts as well as Chrome.
      detached: true,
    });
    this.child = child;
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.wsUrl = null;
      for (const listener of this.exitListeners) listener();
    });
    const deadline = Date.now() + LAUNCH_MS;
    while (Date.now() < deadline) {
      const answer = await probe(version).catch(() => null);
      if (answer && typeof answer["webSocketDebuggerUrl"] === "string") {
        this.wsUrl = answer["webSocketDebuggerUrl"];
        return this.wsUrl;
      }
      if (ended(child)) throw new Error(`Chrome exited with ${child.exitCode ?? child.signalCode} before it answered`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await this.stop();
    throw new Error("Chrome did not answer on its port in time");
  }
}
