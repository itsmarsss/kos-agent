# Benchmarks

## screen.mjs: computer use, Chrome and long documents

How long KOS takes to work a screen, a tab and a long PDF, step by step, so a
change that is meant to make it faster can be shown to.

It needs a scratch KOS, never the owner's. It pairs devices with it, starts
chats and approves what they ask. Run it on a copy of a workspace with its
schedules off (`UPDATE crons SET enabled=0; UPDATE daemons SET enabled=0`),
Discord blanked and a port of its own, for example 4417.

```sh
node scripts/bench/screen.mjs --kos http://127.0.0.1:4417 --workspace <its workspace> \
  --label main --out bench-out [--tasks computer10,computer20,watch,chrome,context,heavy] \
  [--ext packages/browser-extension/dist]
node scripts/bench/screen.mjs --compare bench-out/main.json bench-out/branch.json
```

A full run takes about ten minutes. Start it with `nohup` and read its log.

### What it does

- **A fake KOS for Mac, "Bench Mac".** It pairs with the real handshake. Its
  screen is a page in a headless Chrome, rendered at the size KOS asks for in
  `session.begin` (1280 when it asks for none), over a terminal's worth of
  coloured text, so a picture weighs what a real screen's does (about 200 KB).
  Clicks, keys and scrolls go to that page, so the model reads and acts on
  something real.
  - `computer10`, `computer20`: a setup wizard of 10 or 20 steps, each showing
    a code to type before Next. It cannot be done without looking each time.
    Done when the page says so and the answer has the final code.
  - `watch`: an export that finishes after 45 seconds. Done when the answer has
    its row count.
  - `heavy`: the 10-step wizard in a chat that first holds about 70k tokens of
    notes, where a long chat's turns would be.
- **KOS for Chrome**, loaded into the same Chrome with reading granted, its
  side panel open beside a shop page, Auto on: `chrome-price` (read the
  page), `chrome-cart` (click a button, read it back), `chrome-steps` (five
  clicks in order, looking after each).
- **A long document**: a 30-page PDF in the workspace, read in one turn and
  asked about in three more (`context-read`, `context-lisbon`,
  `context-churn`, `context-s12`), each answer checked for its fact.

### What it records

For every task: whether it was done, the wall time, and every model call the
Claude Agent SDK made, read from the SDK's own log for that workspace
(`~/.claude/projects/<workspace path>/`): when it was asked, how long the model
took, how long the tool took before the next call, and its uncached, cached
and output tokens. `<label>.json` holds all of it; `<label>.md` a table.
`--compare` puts two runs side by side.

It measures the SDK engine, which the owner's chats run on.
