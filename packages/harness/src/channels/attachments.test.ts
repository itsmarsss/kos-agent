import { createServer, type Server } from "node:http";
import type { Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PICTURES } from "../files/images.fixture.js";
import { FILE_MAX_BYTES } from "../kernel/attachments.js";
import { collectAttachments } from "./discord.js";

/**
 * What KOS sees when you send it a file on Discord.
 *
 * Attachments used to be dropped on the floor, so a photo of a receipt reached
 * the model as an empty message and it answered as though nothing had been
 * sent. These cover the download itself against a real socket, and the two
 * ways an attachment is refused: too big, and not something a model can read.
 */

interface FakeAttachment {
  name: string;
  url: string;
  size: number;
  contentType: string | null;
}

/** Only the shape collectAttachments actually touches. */
function fakeMessage(attachments: FakeAttachment[]): Message {
  return { attachments: new Map(attachments.map((a, i) => [String(i), a])) } as unknown as Message;
}

describe("attachments sent on discord", () => {
  let server: Server;
  let base: string;
  const files: Record<string, { body: Buffer; status: number }> = {};

  beforeEach(async () => {
    files["/cat.png"] = { body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), status: 200 };
    files["/notes.txt"] = { body: Buffer.from("remember the milk"), status: 200 };
    files["/gone.png"] = { body: Buffer.from(""), status: 404 };

    server = createServer((req, res) => {
      const file = files[req.url ?? ""];
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(file.status);
      res.end(file.body);
    });
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(() => {
    server.close();
  });

  it("downloads an image and hands over its bytes", async () => {
    const { attachments, skipped } = await collectAttachments(
      fakeMessage([
        { name: "cat.png", url: `${base}/cat.png`, size: 6, contentType: "image/png" },
      ]),
    );
    expect(skipped).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.mediaType).toBe("image/png");
    expect(Buffer.from(attachments[0]!.data, "base64")).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]),
    );
  });

  it("downloads a text file too", async () => {
    const { attachments } = await collectAttachments(
      fakeMessage([
        { name: "notes.txt", url: `${base}/notes.txt`, size: 17, contentType: "text/plain" },
      ]),
    );
    expect(Buffer.from(attachments[0]!.data, "base64").toString()).toBe(
      "remember the milk",
    );
  });

  /*
   * Named, not dropped. "I cannot read a .zip" is an answer the owner can act
   * on; answering as though nothing was attached is not.
   */
  it("names what it cannot read instead of ignoring it", async () => {
    const { attachments, skipped } = await collectAttachments(
      fakeMessage([
        { name: "archive.zip", url: `${base}/cat.png`, size: 10, contentType: "application/zip" },
      ]),
    );
    expect(attachments).toEqual([]);
    expect(skipped[0]).toContain("archive.zip");
  });

  it("refuses something too large before fetching it", async () => {
    const { attachments, skipped } = await collectAttachments(
      fakeMessage([
        {
          name: "huge.png",
          url: `${base}/cat.png`,
          size: 120 * 1024 * 1024,
          contentType: "image/png",
        },
      ]),
    );
    expect(attachments).toEqual([]);
    expect(skipped).toEqual(["huge.png (120.0 MB, too large: files go up to 100 MB)"]);
  });

  it("stops a download that runs past 100 MB, whatever size Discord said", async () => {
    files["/liar.png"] = { body: Buffer.alloc(FILE_MAX_BYTES + 1024 * 1024, 1), status: 200 };
    const { attachments, skipped } = await collectAttachments(fakeMessage([{ name: "liar.png", url: `${base}/liar.png`, size: 10, contentType: "image/png" }]));
    expect(attachments).toEqual([]);
    expect(skipped[0]).toMatch(/^liar\.png \(100\.\d MB, too large: files go up to 100 MB\)$/);
  });

  it("takes an iPhone's HEIC, whatever type Discord gives it, and a picture past the old 5 MB", async () => {
    // Reported: "HEIC not supported" for a photo off the owner's phone, and a 5 MB cap before that.
    files["/IMG_0042.HEIC"] = { body: Buffer.from(PICTURES["image/heic"], "base64"), status: 200 };
    files["/big.png"] = { body: Buffer.alloc(12 * 1024 * 1024, 0x89), status: 200 };
    const { attachments, skipped } = await collectAttachments(
      fakeMessage([
        { name: "IMG_0042.HEIC", url: `${base}/IMG_0042.HEIC`, size: 575, contentType: "image/heic" },
        { name: "IMG_0043.HEIC", url: `${base}/IMG_0042.HEIC`, size: 575, contentType: null },
        { name: "big.png", url: `${base}/big.png`, size: 12 * 1024 * 1024, contentType: "image/png" },
      ]),
    );
    expect(skipped).toEqual([]);
    expect(attachments.map((a) => a.name)).toEqual(["IMG_0042.HEIC", "IMG_0043.HEIC", "big.png"]);
    expect(Buffer.from(attachments[0]!.data, "base64").equals(Buffer.from(PICTURES["image/heic"], "base64"))).toBe(true);
  });

  it("survives a download that fails", async () => {
    const { attachments, skipped } = await collectAttachments(
      fakeMessage([
        { name: "gone.png", url: `${base}/gone.png`, size: 4, contentType: "image/png" },
      ]),
    );
    expect(attachments).toEqual([]);
    expect(skipped[0]).toContain("gone.png");
  });

  it("keeps the good ones when one of several fails", async () => {
    const { attachments, skipped } = await collectAttachments(
      fakeMessage([
        { name: "cat.png", url: `${base}/cat.png`, size: 6, contentType: "image/png" },
        { name: "gone.png", url: `${base}/gone.png`, size: 4, contentType: "image/png" },
        { name: "notes.txt", url: `${base}/notes.txt`, size: 17, contentType: "text/plain" },
      ]),
    );
    expect(attachments.map((a) => a.name)).toEqual(["cat.png", "notes.txt"]);
    expect(skipped).toHaveLength(1);
  });

  it("reads a text file Discord gave no useful type for", async () => {
    const { attachments } = await collectAttachments(
      fakeMessage([
        { name: "notes.md", url: `${base}/notes.txt`, size: 17, contentType: null },
      ]),
    );
    expect(attachments).toHaveLength(1);
  });
});
