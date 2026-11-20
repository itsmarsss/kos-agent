// Where KOS acted, for the tasks that name a place in the owner's words: a Mac and a Chrome are
// both paired, and the owner speaks from the dashboard, so the words alone pick the place.

/**
 * A dashboard chat's turns. Nobody answers the Chrome's ask for a session (it is the side panel's
 * to show, and the panel is on a chat of its own), so a turn that picks the owner's Chrome is
 * graded on asking for it, and on not moving the work elsewhere once the ask lapses.
 */
export async function dashboardTurns(ctx, title, texts, { limitMs = 300_000 } = {}) {
  const chat = await ctx.chat(title);
  const turns = [];
  for (const text of texts) turns.push(await ctx.turn(chat, text, { limitMs }));
  return turns;
}

/** Which places a turn's tools reached after a moment: the owner's computer, their Chrome, KOS's own browser. */
export function placesUsed(tools, since) {
  const after = tools.filter((t) => t.at >= since);
  return {
    mac: after.some((t) => t.tool === "computer.start" || t.tool === "computer.act"),
    chrome: after.some((t) => t.tool === "chrome.start" || /^In the owner's Chrome/.test(String(t.result))),
    kos: after.some((t) => t.tool.startsWith("browser.") && /^In KOS's own browser/.test(String(t.result))),
    names: [...new Set(after.map((t) => t.tool))].join(", "),
  };
}

/** The checkpoints of a turn that had to work in one place and in no other. */
export function onlyIn(ctx, place, since) {
  const used = placesUsed(ctx.tools, since);
  const others = ["mac", "chrome", "kos"].filter((p) => p !== place);
  return [
    ctx.check(`worked in ${place}`, used[place], used.names),
    ctx.check(`no other place (${others.join(", ")})`, others.every((p) => !used[p]), used.names),
  ];
}
