import { describe, expect, it } from "vitest";

import { beyondAutoByName, beyondAutoRule, destructiveCommand } from "./beyondauto.js";

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
    for (const tool of ["systems.project_delete", "chats.delete", "blobs.remove", "daemons.remove", "discord.prune", "skills.commit", "skills.promote", "modules.instantiate"]) {
      expect(beyondAutoRule(tool, {}), tool).toBeTruthy();
    }
  });

  it("holds back a message to anyone but the owner, and a place opened to others", () => {
    expect(beyondAutoRule("notify", { text: "hi" })).toBe(false);
    expect(beyondAutoRule("notify", { text: "hi", to: "owner" })).toBe(false);
    expect(beyondAutoRule("notify", { text: "hi", to: "channel:123" })).toBe("messages someone besides you");
    expect(beyondAutoRule("notify", { text: "hi", to: "user:9" })).toBe("messages someone besides you");
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
