// A stand-in for an OpenAI-compatible model, for the device updates' end-to-end run: it costs nothing, and
// asked to take its time it answers after a few seconds, so a turn is running while a device connects.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4420);
const SLOW_MS = 25_000;

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "stub-1", object: "model" }] }));
    }
    const body = raw ? JSON.parse(raw) : {};
    const said = JSON.stringify(body.messages?.at(-1)?.content ?? "");
    const slow = /take your time/i.test(said);
    const content = slow ? "Done, slowly." : "Hello from the stub model.";
    console.log(req.url, said.slice(0, 120), "->", content);
    const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    setTimeout(() => {
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish = null) =>
          res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        chunk({ role: "assistant", content });
        chunk({}, "stop");
        res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub-1", choices: [], usage })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "r", object: "chat.completion", created: 0, model: "stub-1", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }));
    }, slow ? SLOW_MS : 0);
  });
}).listen(port, "127.0.0.1", () => console.log(`stub model on ${port}`));
