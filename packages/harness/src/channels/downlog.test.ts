import { describe, expect, it } from "vitest";

import { DownLog } from "./downlog.js";

describe("DownLog", () => {
  it("says a drop once, once a minute while down, and once when back", () => {
    const lines: string[] = [];
    let now = 0;
    const log = new DownLog((l) => lines.push(l), () => now);
    for (let i = 0; i < 500; i += 1) {
      now = i * 300;
      log.error("getaddrinfo ENOTFOUND gateway.discord.gg");
    }
    // 150 seconds of retries: the drop, and two minutes' worth of reminders.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Discord: connection lost (getaddrinfo ENOTFOUND gateway.discord.gg)");
    expect(lines[1]).toMatch(/^Discord: still down after 60s \(getaddrinfo ENOTFOUND gateway\.discord\.gg, 199 more like it\)$/);
    expect(log.down).toBe(true);
    now = 200_000;
    log.up();
    log.up();
    expect(lines.at(-1)).toBe("Discord: connected again after 200s");
    expect(lines).toHaveLength(4);
    expect(log.down).toBe(false);
    log.error("again");
    expect(lines.at(-1)).toBe("Discord: connection lost (again)");
  });
});
