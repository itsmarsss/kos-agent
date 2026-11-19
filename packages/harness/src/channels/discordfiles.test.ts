import { createServer, type Server } from "node:http";
import type { Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAttachments } from "../kernel/attachments.js";
import { DiscordAdapter, collectAttachments } from "./discord.js";
import type { InboundMessage } from "./types.js";

const OGG = Buffer.from("OggS fake voice note");

describe("a voice note the owner sends", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end(OGG);
    });
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(() => {
    server.close();
  });

  const voiceMessage = (): Message =>
    ({
      id: "1",
      content: "",
      author: { id: "owner", bot: false, username: "kenny" },
      system: false,
      guild: null,
      channel: { id: "dm" },
      createdTimestamp: Date.now(),
      attachments: new Map([["a", { name: "voice-message.ogg", url: `${base}/v.ogg`, size: OGG.byteLength, contentType: "audio/ogg" }]]),
    }) as unknown as Message;

  it("is fetched and kept, not refused as a file KOS cannot read", async () => {
    const { attachments, skipped, recordings } = await collectAttachments(voiceMessage());
    expect(skipped).toEqual([]);
    expect(recordings.map((r) => r.name)).toEqual(["voice-message.ogg"]);
    expect(Buffer.from(attachments[0]!.data, "base64").equals(OGG)).toBe(true);
  });

  it("says no speech-to-text is configured, and keeps the audio, when none is", async () => {
    const adapter = new DiscordAdapter({ token: "t" });
    adapter.setAuthorizer(() => true);
    const heard: InboundMessage[] = [];
    adapter.onMessage((m) => void heard.push(m));
    await adapter.receiveMessage(voiceMessage());
    expect(heard[0]?.text).toBe("\n\n(voice-message.ogg is kept as audio: no speech-to-text is configured, so it was not transcribed)");
    expect(heard[0]?.attachments?.map((a) => a.mediaType)).toEqual(["audio/ogg"]);
  });

  it("is heard through KOS's speech path when one is configured, whatever model it is", async () => {
    const asked: string[] = [];
    const adapter = new DiscordAdapter({ token: "t", transcribe: async (audio) => (asked.push(audio.name), "remind me to call Sam at four") });
    adapter.setAuthorizer(() => true);
    const heard: InboundMessage[] = [];
    adapter.onMessage((m) => void heard.push(m));
    await adapter.receiveMessage(voiceMessage());
    expect(asked).toEqual(["voice-message.ogg"]);
    expect(heard[0]?.text).toBe("\n\n[voice-message.ogg, transcribed] remind me to call Sam at four");
    expect(heard[0]?.attachments).toHaveLength(1);
  });

  it("reaches the model as a note of where the recording was kept", async () => {
    const [read] = await readAttachments([{ name: "voice-message.ogg", mediaType: "audio/ogg", data: OGG.toString("base64"), path: "uploads/voice-message.ogg" }]);
    expect(read?.mediaType).toBe("text/plain");
    expect(Buffer.from(read!.data, "base64").toString()).toMatch(/^\[voice-message\.ogg: a .* recording, kept at uploads\/voice-message\.ogg\. It was not transcribed here\.\]$/);
  });
});

describe("pictures and PDFs KOS names", () => {
  const files: Record<string, { name: string; data: string }> = {
    "projects/x/chart.png": { name: "chart.png", data: Buffer.from("PNG").toString("base64") },
    "projects/x/report.pdf": { name: "report.pdf", data: Buffer.from("PDF").toString("base64") },
    "projects/x/notes.md": { name: "notes.md", data: Buffer.from("md").toString("base64") },
  };

  function dm(): { adapter: DiscordAdapter; sent: { content?: string; files?: { name: string }[] }[] } {
    const adapter = new DiscordAdapter({ token: "t", fileOf: (path) => files[path] });
    const sent: { content?: string; files?: { name: string }[] }[] = [];
    (adapter as unknown as { client: unknown }).client = { users: { fetch: async () => ({ send: async (p: (typeof sent)[number]) => (sent.push(p), { id: "m" }) }) } };
    return { adapter, sent };
  }

  it("uploads them in the owner's DM, previewed by Discord, beside the words that name them", async () => {
    const { adapter, sent } = dm();
    await adapter.send("owner", { text: "Here: @file:projects/x/chart.png and @file:projects/x/report.pdf, notes in @file:projects/x/notes.md." });
    expect(sent[0]?.files?.map((f) => f.name)).toEqual(["chart.png", "report.pdf"]);
  });

  it("uploads nothing the words do not name, nor a file named in code", async () => {
    const { adapter, sent } = dm();
    await adapter.send("owner", { text: "See `@file:projects/x/chart.png`." });
    expect(sent[0]?.files).toBeUndefined();
  });

  it("uploads nothing in a place others read", async () => {
    const adapter = new DiscordAdapter({ token: "t", fileOf: (path) => files[path] });
    const sent: { files?: unknown[] }[] = [];
    const channel = { id: "c1", guildId: "g1", permissionOverwrites: { cache: new Map() }, isSendable: () => true, send: async (p: { files?: unknown[] }) => (sent.push(p), { id: "m" }) };
    (adapter as unknown as { client: unknown }).client = { channels: { fetch: async () => channel } };
    await adapter.postIn("c1", { text: "Here: @file:projects/x/chart.png" });
    expect(sent[0]?.files).toBeUndefined();
  });

  it("keeps a file KOS attached to its answer as an upload", async () => {
    const { adapter, sent } = dm();
    await adapter.send("owner", { text: "Done.", files: [{ name: "shot.jpg", mediaType: "image/jpeg", data: Buffer.from("JPG").toString("base64") }] });
    expect(sent[0]?.files?.map((f) => f.name)).toEqual(["shot.jpg"]);
  });
});
