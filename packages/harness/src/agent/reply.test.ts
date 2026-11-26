import { describe, expect, it } from "vitest";

import { isBookkeeping, replyFrom } from "./reply.js";

const ANSWER =
  "There's no web URL to hand you: those pages are workspace pages, not a served site (`sites.list` is empty). " +
  "The `@page:book_crm_home` form is the clickable link on this surface; clicking it opens the page. If you want real " +
  "https links you can open in a browser, I'd need to publish the dashboard as a site.";

describe("which words are the reply", () => {
  it("names the calls that only save or post", () => {
    expect(["memory.remember", "notify", "tasks.add", "cron.schedule", "discord.react"].every(isBookkeeping)).toBe(true);
    expect(["pages.list", "sql", "notifyish", "discord.messages", "files.write"].some(isBookkeeping)).toBe(false);
  });

  it("is the words after the last call, without the narration before the calls", () => {
    expect(replyFrom([{ name: "skills.run", said: "I'll run the scanner." }], "Nothing new this hour.")).toEqual({ text: "Nothing new this hour." });
  });

  it("is the answer written before a silent save, when nothing follows it", () => {
    expect(replyFrom([{ name: "sql", said: "I'll check." }, { name: "memory.remember", said: "You spent $3,410 in October." }], "")).toEqual({
      text: "You spent $3,410 in October.",
      from: 1,
    });
  });

  it("is the answer and the line after it when a short line follows a post of it", () => {
    const calls = [{ name: "sites.list" }, { name: "pages.list" }, { name: "notify", said: ANSWER }];
    expect(replyFrom(calls, "Buttons sent above, pick one.")).toEqual({ text: `${ANSWER}\n\nButtons sent above, pick one.`, from: 2 });
  });

  it("is the last line alone when work followed the long words, or the line is long, or the words were short", () => {
    expect(replyFrom([{ name: "notify", said: ANSWER }, { name: "sql" }], "Done.").text).toBe("Done.");
    const long = "x".repeat(130);
    expect(replyFrom([{ name: "notify", said: ANSWER }], long).text).toBe(long);
    expect(replyFrom([{ name: "notify", said: "Posting the kickoff." }], "Sent.").text).toBe("Sent.");
  });

  it("is nothing when the turn ends on work, rather than that work's narration", () => {
    expect(replyFrom([{ name: "sql", said: "Checking the board." }], "")).toEqual({ text: "" });
    expect(replyFrom([{ name: "sql", said: "Checking the board." }, { name: "notify" }], "")).toEqual({ text: "" });
  });
});
