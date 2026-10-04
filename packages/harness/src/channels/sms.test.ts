import { describe, expect, it } from "vitest";

import type { ApprovalDecision, InboundMessage } from "./types.js";
import { chunkSms, SmsAdapter, twilioSignature, verifyTwilioSignature } from "./sms.js";

function adapter(sent: { to: string; body: string }[], dropped: string[] = []) {
  return new SmsAdapter({
    accountSid: "AC1",
    authToken: "tok",
    from: "+15550001111",
    owner: "+15559998888",
    report: (m) => dropped.push(m),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      sent.push({ to: form.get("To") ?? "", body: form.get("Body") ?? "" });
      return new Response("{}", { status: 201 });
    }) as typeof fetch,
  });
}

describe("SMS", () => {
  it("sends to the owner's number only, rendered as text", async () => {
    const sent: { to: string; body: string }[] = [];
    await adapter(sent).send("anyone", { text: "hi", card: { title: "Spend", fields: [{ name: "Today", value: "$12" }] } });
    expect(sent).toEqual([{ to: "+15559998888", body: "hi\n\nSpend\nToday: $12" }]);
  });

  it("splits a long message at a line, within what one text can carry", () => {
    const parts = chunkSms(`${"a".repeat(1000)}\n${"b".repeat(1000)}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("a".repeat(1000));
    expect(parts[1]).toBe("b".repeat(1000));
  });

  it("hands the owner's text to the handler and drops a stranger's", async () => {
    const dropped: string[] = [];
    const a = adapter([], dropped);
    const got: InboundMessage[] = [];
    a.onMessage(async (m) => {
      got.push(m);
    });
    await a.receive({ From: "+15559998888", Body: "what's on today" });
    await a.receive({ From: "+15550000000", Body: "hello?" });
    expect(got).toEqual([{ channel: "sms", senderId: "+15559998888", text: "what's on today" }]);
    // A stranger is logged with the number mostly hidden, and never answered.
    expect(dropped).toEqual(["sms: dropped a text from +•••••••••00"]);
  });

  it("turns a reply to an approval into the decision", async () => {
    const sent: { to: string; body: string }[] = [];
    const a = adapter(sent);
    const decisions: ApprovalDecision[] = [];
    a.onApproval(async (d) => {
      decisions.push(d);
    });
    await a.requestApproval("owner", { id: "7", text: "Approve files.rm?", tool: "files.rm", args: {} });
    expect(sent[0]?.body).toContain('Reply "approve 7"');
    await a.receive({ From: "+15559998888", Body: "always 7" });
    expect(decisions).toEqual([{ id: "7", approved: true, deciderId: "+15559998888", remember: true }]);
  });

  it("checks Twilio's signature the way Twilio computes it", () => {
    // The worked example from Twilio's own documentation.
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
    const sig = twilioSignature(url, params, "12345");
    expect(sig).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(verifyTwilioSignature(url, params, sig, "12345")).toBe(true);
    expect(verifyTwilioSignature(url, params, sig, "wrong")).toBe(false);
    expect(verifyTwilioSignature(url, params, undefined, "12345")).toBe(false);
  });
});
