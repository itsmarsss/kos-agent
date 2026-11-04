# Fast computer use, Chrome and long documents

How KOS was made quicker on a screen, in a tab and through a long document,
and how each part was proved: measured against the build before it, kept only
when it was faster and the work still came out right.

## How it was measured

`scripts/bench/screen.mjs` (see `scripts/bench/README.md`) runs a scratch KOS
through real work on the SDK engine:

- a fake KOS for Mac whose screen is a real page with a busy desktop behind
  it, so each picture weighs what a real screen's does (about 200 KB at 1280
  px): a 10-step and a 20-step wizard that cannot be done without looking,
  and an export to watch until it finishes;
- KOS for Chrome's side panel: read a price, click a button, five clicks in
  order;
- a chat that reads a 30-page PDF and answers three questions about it.

Each task is checked for the right answer, and every model call is timed from
the SDK's own log: model time, tool time, tokens. The model's own latency
moves a lot with the time of day (the same step took 3 s at one hour and 15 s
at another), so a change that matters was run against the old build
alternately, several times, and judged on the median.

## Main against this branch

The whole suite once on each, back to back. A single model call over 60 s is
the provider stalling (no tool and no KOS work was running in it; both builds
had them), so it is counted apart, in brackets.

| Task | main | branch |
| --- | --- | --- |
| computer10 | 208.2 s, 15 calls, median call 3.4 s, peak 37k | 44.3 s, 14 calls, median call 2.1 s, peak 60k |
| computer20 | 166.7 s, 18 calls, median call 3.5 s, peak 43k (+506 s in 1 stalled call), WRONG | 108.5 s, 24 calls, median call 3.0 s, peak 62k (+290 s in 1 stalled call) |
| watch | 26.2 s, 9 calls, median call 3.4 s, peak 48k, WRONG | 13.8 s, 5 calls, median call 4.0 s, peak 54k (+531 s in 1 stalled call) |
| chrome-price | 9.2 s, 4 calls, median call 1.8 s, peak 48k (+254 s in 1 stalled call) | 7.0 s, 2 calls, median call 1.6 s, peak 52k |
| chrome-cart | 19.9 s, 8 calls, median call 1.3 s, peak 49k | 13.2 s, 5 calls, median call 3.3 s, peak 54k (+586 s in 1 stalled call) |
| chrome-steps | 27.9 s, 15 calls, median call 1.6 s, peak 56k | 24.8 s, 9 calls, median call 1.9 s, peak 57k |
| context-read | 80.7 s, 14 calls, median call 3.4 s, peak 69k | 388.0 s, 2 calls, median call 5.5 s, peak 66k |
| context-lisbon | 45.1 s, 13 calls, median call 2.3 s, peak 25k | 10.6 s, 2 calls, median call 2.6 s, peak 66k |
| context-churn | 10.2 s, 1 calls, median call 7.8 s, peak 18k | 5.7 s, 1 calls, median call 4.0 s, peak 52k |
| context-s12 | 98.3 s, 8 calls, median call 4.5 s, peak 35k | 9.4 s, 2 calls, median call 2.4 s, peak 66k |

The PDF chat once more on the branch, with the hard deadlines: 15.9, 10.2,
4.9 and 11.5 s, every answer right. The branch's larger peak prompt is the
tools loaded up front, cached after the first call.

## What made it slow

1. **Every picture went again with every step.** One SDK query runs a whole
   turn, and each of its model calls sends every picture taken so far. With
   real screens a step slowed from about 5 s to about 17 s over ten steps,
   while the prompt grew only from 21k to 35k tokens: the time follows the
   pictures, not the words. The owner's WezTerm session showed the same:
   10 to 27 s a step at 33k to 55k tokens.
2. **Each turn first looked for its own tools.** The SDK deferred KOS's tools
   behind a tool search, so every turn spent one or two model calls finding
   them before it could use one.
3. **A long result was written to a file the model then fished through.** The
   SDK puts a tool result over about 50,000 characters in a file and tells the
   model to read it there; a 30-page PDF turned into a dozen round trips of
   Python reading that file, on the first question and again on each
   follow-up.
4. **Two waits with no end.** An outline call and the embedding for memory
   recall had no timeout of their own, and the OpenAI client waits up to ten
   minutes: twice a turn sat for eight to ten minutes with nothing running.

## What was tried

| # | Change | Measured | Kept |
| --- | --- | --- | --- |
| 1 | Opus hands screen work to a Sonnet 5.5 subagent (SDK) | Chrome tasks 8.0, 15.9, 22.7 s on main against 10.0, 24.5, 35.4 s: the handoff (Opus writing the task, the subagent's own 56k-token start) cost 7 to 12 s a task, and Sonnet was no quicker a step | Off by default. "Screen work" in Settings, Models follows the reasoning model; choosing another turns it on |
| 2 | API engine: steps after a screen call on the screen route | Unit-tested; the owner's chats run the SDK engine | Kept, off until a screen model is chosen |
| 3 | Old pictures dropped three at a time (API engine) | Keeps the cached front of the prompt still for three steps instead of one; unit-tested | Kept |
| 4 | KOS for Mac pictures at 1024 px instead of 1280 | 219 KB a picture to 140 KB; with 5, the 10-step task 138.3 s to 93.6 s | Kept |
| 5 | Tools loaded up front (no tool search) | A one-tool turn 7.5 s to 4.2 s; one or two fewer model calls in every turn | Kept |
| 6 | A turn carries on in a fresh query after 8 pictures, with the task, the steps so far and the screen now | 10-step task, three alternating rounds: 325.2, 271.0, 55.2 s without against 141.3, 167.0, 63.7 s with; median 271.0 s to 141.3 s, every run right. It loses a few seconds when the model is quick, and saves minutes when it is slow | Kept |
| 7 | Big results set aside; a huge one cut under the SDK's 50k line, with an outline and a handle | The PDF chat, back to back: 39.7, 37.1, 4.5, 44.9 s (126.2 s) on main against 11.5, 8.6, 6.6, 24.6 s (51.3 s), every answer right | Kept |
| 8 | Outline calls give up after 15 s | A read turn had hung ten minutes on one | Kept |
| 9 | The recall embedding gives up after 10 s and recall goes on by words | A turn had waited 7.75 minutes before the model was asked anything | Kept |

## How the kept pieces work, and how to switch each off

- **Screen work model** (Settings, Models, "Screen work"). Unset, it is the
  reasoning model and nothing changes. Set to another model, the API engine
  runs each step after a screen call on it, and the SDK engine hands screen
  work to a subagent on it. Set it back to the reasoning model to switch off.
- **Pictures at 1024 px.** `computer.start` asks KOS for Mac for a long side
  of 1024 (`SCREEN_EDGE` in `packages/computer/src/tools.ts`). Remove it for
  the device's 1280.
- **No tool search.** The SDK turn runs with `ENABLE_TOOL_SEARCH=false`
  (`packages/harness/src/chat/sdkchat.ts`); every tool is in the first prompt
  and cached after.
- **Bounded queries.** After 8 pictures in one SDK query, KOS interrupts it
  once the last picture is back and carries the turn on in a fresh query: the
  owner's words, every step so far with what it answered, and the screen as it
  is now. The fresh query sends one picture instead of eight. Set
  `KOS_PICTURES_PER_QUERY=0` in the host's environment to run each turn in one
  query.
- **Big results set aside** (Settings, Behaviour, "Set big results aside once
  read"). A result over 32,000 characters (about 8k tokens) is kept whole under
  the workspace (`.kos/results/`) and in the chat for the turn it came in and
  the next; then it is a stub: what it was, where from, a short outline from the
  cheap model, and a handle. `context.recall` brings back a search or a range.
  Stubs are written once and every one due is applied at the start of a turn,
  so the history changes once per result and the prompt cache holds. On the
  SDK engine a result over 48,000 characters comes as its first 40,000, an
  outline and its handle, under the SDK's 50,000-character file limit. Switch
  off in Settings, Behaviour.
- **Time limits.** Outlines wait 15 s and recall embeddings 10 s at most;
  past that the turn goes on without them.

## Not done

- **JPEG quality.** KOS for Mac encodes at 0.8; 0.6 would roughly halve the
  bytes again. It needs a change to the app and a protocol field, measured on
  the real Mac.
- **A warm SDK process.** Reusing one process across messages means the SDK
  keeps its own copy of the conversation, apart from KOS's transcript.
- **Timing on the owner's Mac.** The benchmark's Mac is a fake with a real
  page for a screen; the owner's own sessions are the next measurement.
- **Settling after an action.** A step's tool time is about 0.75 s, of which
  0.45 s is the fixed settle; it is a tenth of a step at most.
