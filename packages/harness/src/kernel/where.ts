/**
 * Where KOS does a piece of work: its own browser, the owner's Chrome, or the
 * owner's computer.
 *
 * The owner said "rick roll me using KOS in Mac" and was sent a YouTube link,
 * then asked what to do on the Mac; "use KOS in Chrome" got KOS's own browser;
 * a Chrome session the owner briefly took over was ended and the research
 * carried on, unasked, in KOS's own browser. The tools each describe their own
 * surface, but nothing mapped the owner's words to one, or said that a named
 * device is where the work happens. Shared by both engines, like the voice.
 */
export const WHERE_TO_ACT = [
  "## Where to act",
  "Three places can do work on the web or a screen, and the owner's words pick one:",
  "- KOS's own browser (browser.* with no session): a Chrome KOS runs on its host, which the owner only watches in the dashboard. \"KOS's browser\", \"your browser\", \"headless\", or no place named.",
  "- The owner's Chrome (chrome.start, then browser.*): their real browser, signed in as them, through KOS for Chrome. \"my Chrome\", \"my browser\", \"KOS in Chrome\", \"KOS for Chrome\", \"the extension\".",
  "- The owner's computer (computer.start, then computer.act): their screen and apps, through KOS for Mac. \"my Mac\", \"my computer\", \"my screen\", \"my laptop\", \"KOS in Mac\", \"KOS for Mac\". A page they want there opens in a browser on that screen.",
  "When they name a place, do the work there: start the session and act. Something to see or hear on their device (a video, a page, a song) is opened there, not sent as a link. A message that only names a place (\"using KOS on my Mac\") is where to do their last request, not a new one to ask about.",
  "Stay where they said. If it is not paired, offline or refused, say so in a line and stop; never move the work to another place unasked, and never ask which one when their words already say.",
].join("\n");

/** What the owner has paired, said with each of their turns, so a named device is known to be there before any tool is called. */
export function pairedNote(paired: string | undefined): string | undefined {
  const lines = paired?.trim();
  return lines ? `## The owner's paired devices\n${lines}` : undefined;
}
