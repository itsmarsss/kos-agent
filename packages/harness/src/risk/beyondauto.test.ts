import { describe, expect, it } from "vitest";

import { addressesIn, checkoutVerdict, PAY_BUTTON, PAY_FRAMES, beyondAutoByName, beyondAutoRule, destructiveCommand, looksLikeCheckout } from "./beyondauto.js";

describe("beyondAutoByName", () => {
  it("names a tool that spends money, deletes or cancels", () => {
    expect(beyondAutoByName("mcp.stripe.create_payment")).toBe("may spend money");
    expect(beyondAutoByName("mcp.shop.checkout")).toBe("may spend money");
    expect(beyondAutoByName("mcp.shop.place_order")).toBe("may spend money");
    expect(beyondAutoByName("mcp.bank.sendMoney")).toBe("may spend money");
    expect(beyondAutoByName("mcp.give.donate")).toBe("may spend money");
    expect(beyondAutoByName("mcp.news.subscribe")).toBe("may spend money");
    expect(beyondAutoByName("mcp.drive.delete_file")).toMatch(/delete or cancel/);
    expect(beyondAutoByName("mcp.github.removeLabel")).toMatch(/delete or cancel/);
    expect(beyondAutoByName("mcp.cal.cancel_event")).toMatch(/delete or cancel/);
    expect(beyondAutoByName("mcp.auth.revoke_token")).toMatch(/delete or cancel/);
  });

  it("leaves other names alone, words that only contain one included", () => {
    expect(beyondAutoByName("mcp.drive.list_files")).toBe(false);
    expect(beyondAutoByName("mcp.notes.reorder")).toBe(false);
    expect(beyondAutoByName("mcp.maps.dropoff_time")).toBe(false);
    expect(beyondAutoByName("mcp.chat.display")).toBe(false);
  });
});

describe("beyondAutoRule", () => {
  it("holds back what deletes for good or changes KOS itself", () => {
    for (const tool of ["systems.project_delete", "chats.delete", "blobs.remove", "daemons.remove", "discord.prune", "skills.commit", "skills.promote", "modules.instantiate", "modules.create", "modules.promote", "daemons.create", "daemons.start", "sites.create", "cron.schedule", "discord.role", "discord.react"]) {
      expect(beyondAutoRule(tool, {}), tool).toBeTruthy();
    }
  });

  it("holds back a message to anyone but the owner, and a place opened to others", () => {
    expect(beyondAutoRule("discord.audience", { channel: "x", audience: "owner" })).toBe(false);
    expect(beyondAutoRule("discord.audience", { channel: "x", audience: "everyone" })).toBeTruthy();
    expect(beyondAutoRule("files.write", {})).toBe(false);
  });
});

describe("destructiveCommand", () => {
  const exists = (p: string): boolean => ["notes.md", "src/app.ts", "scratch/out.txt"].includes(p);
  const scratch = (p: string): boolean => p.startsWith("scratch/");
  const d = (c: string): string | false => destructiveCommand(c, exists, scratch);

  it("names each way a line destroys work", () => {
    expect(d("rm -rf build")).toBe("deletes recursively");
    expect(d("cd x && rm -v -R old")).toBe("deletes recursively");
    expect(d("git push --force origin main")).toBe("force-pushes");
    expect(d("git push -f")).toBe("force-pushes");
    expect(d("git push origin +main")).toBe("force-pushes");
    expect(d("git reset --hard HEAD~3")).toMatch(/reset --hard/);
    expect(d("git clean -fdx")).toMatch(/git clean/);
    expect(d("dd if=/dev/zero of=disk.img bs=1m")).toMatch(/dd/);
    expect(d("mkfs.ext4 /dev/sdb1")).toBe("formats a disk");
    expect(d("chmod -R 777 .")).toMatch(/recursively/);
    expect(d("chown -R me .")).toMatch(/recursively/);
    expect(d("echo hi > notes.md")).toBe("overwrites notes.md");
    expect(d("cat a >src/app.ts")).toBe("overwrites src/app.ts");
  });

  it("lets ordinary work through", () => {
    expect(d("rm notes.md")).toBe(false);
    expect(d("git push origin main")).toBe(false);
    expect(d("git reset HEAD file")).toBe(false);
    expect(d("echo hi >> notes.md")).toBe(false);
    expect(d("echo hi > new.md")).toBe(false);
    expect(d("echo hi > scratch/out.txt")).toBe(false);
    expect(d("make 2>&1 | tee log")).toBe(false);
    expect(d("cmd > /dev/null 2>&1")).toBe(false);
    expect(d("chmod +x run.sh")).toBe(false);
    expect(d("pnpm build")).toBe(false);
  });
});

describe("looksLikeCheckout", () => {
  const page = (text: string, cardField = false) => ({ text, cardField });

  it("names a checkout by its address, a card field or its words", () => {
    expect(looksLikeCheckout(["https://shop.example/checkout/step-2"], undefined)).toMatch(/checkout or payment page/);
    expect(looksLikeCheckout(["https://shop.example/cart"], undefined)).toBe(false);
    expect(looksLikeCheckout(["https://shop.example/a"], page("Shipping", true))).toMatch(/card field/);
    expect(looksLikeCheckout(["https://shop.example/a"], { ...page("Review, then Place order"), payButton: true })).toMatch(/reads like a checkout/);
    // A footer's "Payment methods" alone is not a checkout.
    expect(looksLikeCheckout(["https://shop.example/a"], page("Payment methods we take"))).toBe(false);
    expect(looksLikeCheckout(["https://shop.example/a"], { ...page(""), payButton: true })).toMatch(/button that pays/);
    expect(PAY_BUTTON.test("Place order")).toBe(true);
    expect(PAY_BUTTON.test("Pay $12.00")).toBe(true);
    expect(PAY_BUTTON.test("Payment methods")).toBe(false);
    expect(looksLikeCheckout([], page("The weather in Lisbon"))).toBe(false);
    expect(looksLikeCheckout(["https://shop.example/buy/now"], undefined)).toMatch(/checkout or payment page/);
    expect(looksLikeCheckout([], { text: "", cardField: false, payFrame: true })).toMatch(/payment provider/);
    expect(PAY_FRAMES.test("https://js.stripe.com/v3/elements-inner-card.html")).toBe(true);
    expect(PAY_FRAMES.test("https://www.youtube.com/embed/x")).toBe(false);
  });

  it("finds the addresses a call's steps would open", () => {
    expect(addressesIn({ actions: [{ open: "https://a.example/pay" }, { click: "@e1" }, { goto: "b.example" }] })).toEqual(["https://a.example/pay", "b.example"]);
  });
});

describe("checkoutVerdict", () => {
  it("fails closed: a page that could not be read holds back a step that touches it", () => {
    expect(checkoutVerdict(["https://a.example/"], undefined, true)).toMatch(/could not read the page/);
    expect(checkoutVerdict(["https://a.example/"], undefined, false)).toBe(false);
    expect(checkoutVerdict([], null, true)).toBe(false);
    expect(checkoutVerdict(["https://a.example/checkout"], undefined, false)).toMatch(/checkout/);
    expect(checkoutVerdict([], { text: "Pay now", cardField: false, payButton: true }, true)).toMatch(/reads like a checkout/);
    expect(checkoutVerdict([], { text: "Pay now", cardField: false }, true)).toBe(false);
  });
});
