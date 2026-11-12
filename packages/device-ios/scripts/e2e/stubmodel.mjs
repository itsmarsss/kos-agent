// A stand-in for an OpenAI-compatible model, for the phone's end-to-end run: it costs nothing and says the
// same every time. Asked to make the file, it calls the shell tool, which KOS holds for the owner's approval;
// asked to make the doc, it writes an artifact for the phone to read; asked to make the Inbox's file, it calls the
// shell tool again, for the phone's Inbox to deny; shown a picture, it counts the pictures;
// shown the tool's result, it says it is done; anything else it greets.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4428);

function reply(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1) ?? {};
  if (last.role === "tool") return { content: "Done: the file is made." };
  // The newest message only, which leads with what KOS recalled (older words among it): so a picture is counted
  // first, and the doc is asked for before the file, whose words it may recall.
  const said = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
  const pictures = Array.isArray(last.content) ? last.content.filter((p) => p.type === "image_url").length : 0;
  if (pictures) return { content: `I see ${pictures} picture${pictures === 1 ? "" : "s"}.` };
  const tool = (re) => (body.tools ?? []).map((t) => t.function?.name).find((n) => re.test(n ?? ""));
  const shell = tool(/^shell(__|\.|_)run$/);
  // Ahead of the doc and the file, whose words it may recall.
  if (/make the inbox file/i.test(said) && shell) {
    return { tool: { id: "call_inbox", name: shell, arguments: JSON.stringify({ command: "touch phone-inbox.txt" }) } };
  }
  const write = tool(/^artifacts(__|\.|_)write$/);
  if (/make the e2e doc/i.test(said) && write) {
    const html = "<article data-doc><h1>Phone e2e</h1><p>Read on the phone, as the dashboard draws it.</p></article>";
    return { tool: { id: "call_doc", name: write, arguments: JSON.stringify({ id: "phone-e2e-doc", kind: "doc", title: "Phone e2e", html }) } };
  }
  if (/make the e2e file/i.test(said) && shell) {
    return { tool: { id: "call_e2e", name: shell, arguments: JSON.stringify({ command: "touch phone-e2e.txt" }) } };
  }
  return { content: "Hello from the stub model." };
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "stub-1", object: "model" }] }));
    }
    const body = raw ? JSON.parse(raw) : {};
    const out = reply(body);
    // What it was asked and said, in model.log, for a run kept with KOS_E2E_KEEP.
    console.log(req.url, JSON.stringify(body.messages?.at(-1)?.content ?? "").slice(0, 160), "->", JSON.stringify(out).slice(0, 120));
    const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (out.tool) {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: out.tool.id, type: "function", function: { name: out.tool.name, arguments: out.tool.arguments } }] });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: out.content });
        chunk({}, "stop");
      }
      res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub-1", choices: [], usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const message = out.tool
      ? { role: "assistant", content: null, tool_calls: [{ id: out.tool.id, type: "function", function: { name: out.tool.name, arguments: out.tool.arguments } }] }
      : { role: "assistant", content: out.content };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "r", object: "chat.completion", created: 0, model: "stub-1", choices: [{ index: 0, message, finish_reason: out.tool ? "tool_calls" : "stop" }], usage }));
  });
}).listen(port, "127.0.0.1", () => console.log(`stub model on ${port}`));
