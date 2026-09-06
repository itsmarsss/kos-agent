import { describe, expect, it } from "vitest";

import { Heartbeat, HEARTBEAT_PROMPT } from "./heartbeat.js";

/** A clock the test drives, so nothing waits on real minutes. */
function fakeTimers() {
  let now = 0;
  const queue: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const setTimer = ((fn: () => void, ms: number) => {
    const id = nextId++;
    queue.push({ at: now + ms, fn, id });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((id: unknown) => {
    const i = queue.findIndex((t) => t.id === id);
    if (i >= 0) queue.splice(i, 1);
  }) as unknown as typeof clearTimeout;
  /** Run every timer due within `ms`, in order, as real time would. */
  async function advance(ms: number): Promise<void> {
    const until = now + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at);
      const next = queue[0];
      if (!next || next.at > until) break;
      queue.shift();
      now = next.at;
      next.fn();
      // Let the beat's promise settle before the next timer is considered.
      await Promise.resolve();
      await Promise.resolve();
    }
    now = until;
  }
  return { setTimer, clearTimer, advance };
}

describe("waking up on its own", () => {
  it("does nothing at all while the interval is zero", async () => {
    /*
     * Off is the default, because this is the one thing in KOS that spends
     * money on a timer rather than because the owner asked for something.
     */
    const timers = fakeTimers();
    let beats = 0;
    const heart = new Heartbeat({
      interval: () => 0,
      beat: async () => {
        beats += 1;
      },
      allowed: () => true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    heart.start();
    await timers.advance(6 * 60 * 60_000);
    heart.stop();

    expect(beats).toBe(0);
  });

  it("beats on the interval the owner set", async () => {
    const timers = fakeTimers();
    let beats = 0;
    const heart = new Heartbeat({
      interval: () => 30,
      beat: async () => {
        beats += 1;
      },
      allowed: () => true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    heart.start();
    await timers.advance(95 * 60_000);
    heart.stop();

    expect(beats).toBe(3);
  });

  it("starts beating when the interval is turned on, without a restart", async () => {
    // The timer re-reads the setting, so switching it on in the dashboard
    // takes effect rather than waiting for someone to bounce the host.
    const timers = fakeTimers();
    let minutes = 0;
    let beats = 0;
    const heart = new Heartbeat({
      interval: () => minutes,
      beat: async () => {
        beats += 1;
      },
      allowed: () => true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    heart.start();
    await timers.advance(5 * 60_000);
    expect(beats).toBe(0);

    minutes = 15;
    await timers.advance(40 * 60_000);
    heart.stop();
    expect(beats).toBeGreaterThan(0);
  });

  it("stays quiet while KOS is halted", async () => {
    // The kill switch means stop, and a beat is KOS acting on its own, which
    // is the first thing that should stop.
    const timers = fakeTimers();
    let beats = 0;
    let halted = true;
    const heart = new Heartbeat({
      interval: () => 10,
      beat: async () => {
        beats += 1;
      },
      allowed: () => !halted,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    heart.start();
    await timers.advance(60 * 60_000);
    expect(beats).toBe(0);

    halted = false;
    await timers.advance(30 * 60_000);
    heart.stop();
    expect(beats).toBeGreaterThan(0);
  });

  it("keeps beating after one throws", async () => {
    const timers = fakeTimers();
    let beats = 0;
    const heart = new Heartbeat({
      interval: () => 10,
      beat: async () => {
        beats += 1;
        throw new Error("the turn failed");
      },
      allowed: () => true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    heart.start();
    await timers.advance(35 * 60_000);
    heart.stop();

    expect(beats).toBeGreaterThan(1);
  });

  it("does not start the next beat until the last one is done", async () => {
    // Scheduled one at a time, so a slow look-around cannot pile up behind
    // itself and run several turns at once.
    const timers = fakeTimers();
    let running = 0;
    let overlapped = false;
    let release: (() => void) | undefined;
    const heart = new Heartbeat({
      interval: () => 10,
      beat: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise<void>((r) => {
          release = r;
        });
        running -= 1;
      },
      allowed: () => true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    heart.start();
    await timers.advance(45 * 60_000);
    release?.();
    heart.stop();

    expect(overlapped).toBe(false);
  });

  it("schedules nothing more once stopped", async () => {
    const timers = fakeTimers();
    let beats = 0;
    const heart = new Heartbeat({
      interval: () => 5,
      beat: async () => {
        beats += 1;
      },
      allowed: () => true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    heart.start();
    heart.stop();
    await timers.advance(60 * 60_000);

    expect(beats).toBe(0);
    expect(heart.pending).toBe(false);
  });
});

describe("what a beat asks for", () => {
  it("makes saying nothing the expected outcome", () => {
    /*
     * The failure mode is a thing that reports in every half hour to say
     * there is nothing to report, until the owner stops reading it and misses
     * the one that mattered. The prompt has to make silence comfortable.
     */
    expect(HEARTBEAT_PROMPT).toContain("say nothing at all");
    expect(HEARTBEAT_PROMPT).toContain("Silence is the normal outcome");
    expect(HEARTBEAT_PROMPT).toContain("Do not send a status");
    expect(HEARTBEAT_PROMPT).toContain("Do not repeat something you already");
  });
});
