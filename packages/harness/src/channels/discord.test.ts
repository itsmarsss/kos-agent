import { describe, expect, it } from "vitest";

import {
  APPROVE_PREFIX,
  DENY_PREFIX,
  approvalCustomIds,
  chunkText,
  parseApprovalCustomId,
} from "./discord.js";

describe("discord approval customId codec", () => {
  it("encodes approve and deny ids for a pending action", () => {
    expect(approvalCustomIds("p1")).toEqual({
      approve: `${APPROVE_PREFIX}p1`,
      deny: `${DENY_PREFIX}p1`,
    });
  });

  it("round-trips an approve decision", () => {
    const { approve } = approvalCustomIds("abc");
    expect(parseApprovalCustomId(approve)).toEqual({ id: "abc", approved: true });
  });

  it("round-trips a deny decision", () => {
    const { deny } = approvalCustomIds("abc");
    expect(parseApprovalCustomId(deny)).toEqual({ id: "abc", approved: false });
  });

  it("returns null for an unrelated customId", () => {
    expect(parseApprovalCustomId("other:thing")).toBeNull();
  });

  it("preserves ids containing separators", () => {
    const { approve } = approvalCustomIds("a:b:c");
    expect(parseApprovalCustomId(approve)).toEqual({
      id: "a:b:c",
      approved: true,
    });
  });
});

describe("chunkText", () => {
  it("leaves short text alone", () => {
    expect(chunkText("hi", 10)).toEqual(["hi"]);
  });

  it("splits long text on newlines when possible", () => {
    const chunks = chunkText("aaaa\nbbbb\ncccc", 6);
    expect(chunks.join("").replace(/\n/g, "").length).toBe(12);
    expect(chunks.every((c) => c.length <= 6)).toBe(true);
  });
});
