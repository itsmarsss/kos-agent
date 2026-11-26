import { describe, expect, it } from "vitest";

import { isBookkeeping, replyFrom } from "./reply.js";

const ANSWER =
  "There's no web URL to hand you: those pages are workspace pages, not a served site (`sites.list` is empty). " +
  "The `@page:book_crm_home` form is the clickable link on this surface; clicking it opens the page. If you want real " +
  "https links you can open in a browser, I'd need to publish the dashboard as a site.";

describe("which words are the reply", () => {
  it("names only the calls that write down or deliver, never a read or an action", () => {
    expect(["memory.remember", "memory.observe", "notify", "tasks.add", "cron.schedule", "discord.react"].every(isBookkeeping)).toBe(true);
    expect(["memory.recall", "memory.threads", "memory.page", "tasks.list", "cron.list", "cron.run", "pages.list", "discord.messages"].some(isBookkeeping)).toBe(false);
  });

  it("is the words after the last call, without the narration before the calls", () => {
    expect(replyFrom([{ name: "skills.run", said: "I'll run the scanner." }], "Nothing new this hour.", "done")).toEqual({ text: "Nothing new this hour." });
  });

  it("is the answer written before a silent save, when the turn ended on its own with nothing after it", () => {
    expect(replyFrom([{ name: "sql", said: "I'll check." }, { name: "memory.remember", said: ANSWER }], "", "done")).toEqual({ text: ANSWER, from: 1 });
  });

  it("is nothing when the words before the save were a line about it, or the turn was cut short", () => {
    expect(replyFrom([{ name: "memory.remember", said: "I'll save that." }], "", "done")).toEqual({ text: "" });
    expect(replyFrom([{ name: "memory.remember", said: ANSWER }], "", "cut")).toEqual({ text: "" });
  });

  it("never takes the words before a read or an action, whatever follows", () => {
    expect(replyFrom([{ name: "cron.list", said: ANSWER }], "", "done")).toEqual({ text: "" });
    expect(replyFrom([{ name: "memory.recall", said: ANSWER }], "Nothing on file.", "done")).toEqual({ text: "Nothing on file." });
  });

  it("is the answer and the line after it when a short line follows a post of it", () => {
    const calls = [{ name: "sites.list" }, { name: "pages.list" }, { name: "notify", said: ANSWER }];
    expect(replyFrom(calls, "Buttons sent above, pick one.", "done")).toEqual({ text: `${ANSWER}\n\nButtons sent above, pick one.`, from: 2 });
  });

  it("is the last line alone when work followed the long words, or the line is long, or the words were short", () => {
    expect(replyFrom([{ name: "notify", said: ANSWER }, { name: "sql" }], "Done.", "done").text).toBe("Done.");
    const long = "x".repeat(130);
    expect(replyFrom([{ name: "notify", said: ANSWER }], long, "done").text).toBe(long);
    expect(replyFrom([{ name: "notify", said: "Posting the kickoff." }], "Sent.", "done").text).toBe("Sent.");
  });

  it("is nothing when the turn ends on work, rather than that work's narration", () => {
    expect(replyFrom([{ name: "sql", said: "Checking the board." }], "", "done")).toEqual({ text: "" });
    expect(replyFrom([{ name: "sql", said: ANSWER }, { name: "notify" }], "", "done")).toEqual({ text: "" });
  });
});
