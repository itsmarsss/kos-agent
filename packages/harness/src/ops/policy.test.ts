import { describe, expect, it } from "vitest";

import { withRetry } from "./policy.js";

describe("withRetry", () => {
  it("returns the first successful result without retrying", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      { retries: 2 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries until success", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error("flaky");
        return "ok";
      },
      { retries: 2 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("throws the last error after exhausting retries", async () => {
    let calls = 0;
    const errors: number[] = [];
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("always");
        },
        { retries: 2, onError: (_e, attempt) => errors.push(attempt) },
      ),
    ).rejects.toThrow("always");
    expect(calls).toBe(3); // initial + 2 retries
    expect(errors).toEqual([0, 1, 2]);
  });
});
