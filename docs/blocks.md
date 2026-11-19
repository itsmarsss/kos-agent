# Typed blocks

A typed block is how KOS writes a thing that is more than prose: an email
or message draft, an event, a checklist, a command. Every surface that can
draws it as that thing, with its fields laid out and its own actions (Copy,
Open in Mail, an .ics); every surface that cannot says it in plain words.
The stored reply keeps the block as written, so search, memory and the
model's history read text.

This page is the contract. `packages/shared/src/blocks.ts` reads it for
the web and the channels, `DeviceKit`'s `KOSBlock.swift` for KOS for Mac
and the phone.

## Grammar

A typed block is a fenced block whose info string is `kos:<kind>`:

````
```kos:email
to: sam@example.com
cc: amy@example.com
subject: Saturday at 4
---
Hi Sam,

Still on for Saturday at 4?
```
````

- **Fence.** A line of three or more backticks, then an info string with no
  backtick in it, as CommonMark has it; its first word is the language, and
  a typed block's is `kos:<kind>` (` ```ts title="a.ts" ` is ts code). It
  closes on a line of at least as many backticks and nothing else, so a
  block that holds a fence in its body opens with four. A fence the input
  ends inside (a reply still arriving, or one cut short) runs to the end,
  and its block offers Copy alone until it closes.
- **Where.** A block at the top level of a reply, or inside a list item
  (the item's indent taken off its lines), is drawn as its kind. One inside
  a quote stays words.
- **Kind.** A letter, then letters, digits and hyphens. Read case-folded.
- **Header.** Lines of `key: value`, before the first line that is `---`
  alone. A key is a letter then letters, digits, `-` and `_`, written in
  lowercase (a reader folds case). A value is one line, trimmed; an empty
  one is no value. A key may repeat, which makes a list, kept in order.
  Blank lines in the header are ignored.
- **Body.** Every line after the first `---`, verbatim, with only the blank
  lines at its very start and end taken off. It may hold `---` lines of its
  own. A block with no `---` line is all header and has an empty body.
- **Either half may be empty.** `---` and a body alone is a block with no
  header; a header alone is a block with no body.
- **Malformed.** A header line that is not `key: value` makes the block
  malformed, and it is drawn as the plain code block it would otherwise
  have been. No text is ever lost.
- **`action:`** On any kind, `action: open <https url> [words]` adds a link
  that opens the address, labelled by the words ("Open" without them) with
  the host it really goes to beside them, as the browser reaches it
  (punycode for another script). Only `https:` with no user or password in
  it is a link, and marks that turn text around are taken out of the words.
  No other action can be asked for in a block; the kind decides the rest.

## Kinds

The registry is `BLOCK_KINDS` in `packages/shared/src/blockkinds.ts`, kept
in Swift in `KOSBlock.swift`; a test fails when the two drift.

| Kind | Fields (title in bold) | Body | Actions |
| --- | --- | --- | --- |
| `email` | to (list), cc (list), bcc (list), subject | the email | Copy (body), Open in Mail, Send |
| `message` | to (list), channel (`imessage`, `sms`, `discord`) | the message | Copy (body), Send |
| `event` | **title**, when, end, where, notes | notes | Copy, .ics (dashboard) |
| `contact` | **name**, phone (list), email (list), company, address, notes | notes | Copy |
| `address` | **name**, phone, notes | the address | Copy (body), Map |
| `checklist` | **title** | `- [ ] item` lines, ticked in the view only | Copy (body) |
| `steps` | **title** | a step a line; numbers and bullets taken off | Copy (body) |
| `quote` | source | the quote | Copy (body) |
| `command` | cwd | one command, monospace | Copy (body) |
| `diff` | **file** | a unified diff, lines coloured by `+`, `-`, `@@` | Copy (body) |
| `card` | **title**, any | prose | Copy |

A kind not in the table is a card under its own name: `kos:recipe` is
headed "Recipe". A field a kind does not know is drawn after its own, by
its key ("follow-up" as "Follow up").

- **when / end.** A time token, `<t:2026-11-21T16:00:f>`, which every
  surface already draws on the reader's clock and the channels say in words;
  a date alone (`2026-11-21`) for a whole day; `2026-11-21 16:00` is read
  too. The .ics keeps the time as written, on the owner's clock (a floating
  time); an event with no end lasts an hour, or a day.
- **channel** is drawn by its name: `imessage` as iMessage, `sms` as SMS,
  `discord` as Discord.
- **Copy** copies the body of a draft, a command or a list, and the whole
  block in words otherwise.
- **Send** is shown only when this KOS has a tool for it: for an email, one
  whose name holds "mail" and "send"; for a message, `notify` on Discord,
  else one whose name holds the channel and "send". It sends the owner's
  words to KOS asking it to send the draft with that tool, the draft quoted
  exactly and named as data, to go only to the recipients in its header.
  Only KOS's own words offer it, never the owner's or a guest's. The tool call is tiered and approved as any other: nothing in a
  block acts on its own.

## On Discord

KOS's own blocks are embeds: the kind and title as its heading, a field a
row, the body as its description in the kind's style (code as code, a
checklist ticked, steps numbered), and buttons: Copy, answered to the
presser alone as a code block; Send, under the same rule as above, as the
owner's words in the chat; a link for each `action: open`, its host beside
its words. Five a message, the rest in plain words; the owner's own words
are shown as written.

## Plain words

iMessage and SMS have no block view, so a block goes out as
`plainOf` says it: a heading, a line per field, a blank line, the body.

```
Draft email
To: sam@example.com
Cc: amy@example.com
Subject: Saturday at 4

Hi Sam,

Still on for Saturday at 4?
```

A card's heading is its title; another kind's is its plain label, then its
title after a colon (`Event: Dinner`). Copying a whole message copies it as
written, block and all.
