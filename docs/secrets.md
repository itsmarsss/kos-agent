# Secrets

The model never sees a secret. KOS holds two kinds:

- **Harness keys** in the host's `.env` (`ANTHROPIC_API_KEY`, `KOS_SECRET_<NAME>`),
  as before. They stay there.
- **The owner's secrets**: logins, cards, API keys and notes, in an encrypted
  vault outside the workspace. This page is about the vault.

The agent names a secret by its handle and never by its value. A value is
resolved in the harness at the moment of a call, only where a tool declared a
slot for one (an `http.fetch` header or query string), and only to a host the
secret is bound to. Every value is also watched for by the scrubber, which
takes it out of anything KOS keeps or shows.

## A secret

A secret is one record with a stable handle. The handle is an id, never a
name: the label's slug, a dash and four random characters, such as
`visa-personal-7k2q`. The label is for display and can be renamed.

| Kind | Fields | Scanned for |
| --- | --- | --- |
| `login` | `password`, `username` | password as it is and encoded; username not |
| `card` | `number`, `expiry`, `cvc`, `name`, `billing` | number by its digits, however spaced; the rest not |
| `apikey` | `token`, `username` | token as it is and encoded |
| `note` | `text` | the text and each line of 8 or more characters |

`{{secret:<handle>}}` means the kind's first field (a password, a card
number, a token, a note's text); `{{secret:<handle>.<field>}}` names one.

Record, sealed whole (metadata included):

```json
{
  "handle": "github-9xq1",
  "label": "GitHub",
  "kind": "login",
  "values": { "username": "owner", "password": "..." },
  "use": {
    "web": { "origins": ["https://github.com"], "frames": [] },
    "apps": [],
    "http": { "hosts": [], "as": "bearer" }
  },
  "policy": { "ask": "always", "unattended": false, "chats": null, "grants": [] },
  "hint": "••••••••",
  "createdAt": 1763400000000,
  "updatedAt": 1763400000000,
  "version": 1
}
```

- `use.web.origins`, `use.web.frames`: `https://host[:port]` or
  `https://*.example.com`; `http://localhost` is the one plain-http origin.
- `use.apps`: Mac bundle ids.
- `use.http.hosts`: where `http.fetch` may send it, as `KOS_SECRET_<NAME>_HOSTS`
  does for an env key. Bound nowhere, it is sent nowhere.
- `policy.ask`: `always`, `turn` (one yes covers the turn) or `site` (a
  remembered grant skips the ask, still audited). Grants are added only by an
  approval and taken back only by the owner. A grant on an origin no longer in
  `use.web.origins` is dropped.
- `policy.unattended` (default false) and `policy.chats` (null is any of the
  owner's chats) are enforced wherever a vault secret is placed: a guest's
  turn never gets one, an unattended turn (a schedule, a dispatch, a timer)
  only with `unattended`, and only in the chats `chats` names. Env secrets
  have no policy.
- An ask that places a secret is never decided on Discord, SMS or iMessage:
  those surfaces are told "decide on the dashboard or a paired device", and a
  press there decides nothing; a Discord that reconnects is not sent its
  card. A fill in the owner's Chrome is also decided in KOS for Chrome's
  side panel beside the page, its card carrying the secret's block.
- The hint never holds enough of a value to matter: a card's last four, a
  key's last four when it is longer than twelve, eight dots for a login.

## The vault

`~/.kos/secrets/` at mode 0700, or `KOS_VAULT_DIR`. Never in the workspace,
so never in its git snapshots, and hidden from every jailed program.

KOS reads the folder and its files only when they are its own and private:
a folder or key file another user owns, or one the group or the world can
read, is refused and the vault stays shut with the reason in its status.
Files are opened without following links (`O_NOFOLLOW`) and checked on the
open descriptor.

- `key`: 32 random bytes as base64, mode 0600, marked to stay out of Time
  Machine (`com.apple.metadata:com_apple_backup_excludeItem`). Only a vault
  without a passphrase has one.
- `vault.kosv`: JSON, mode 0600, written atomically: a fresh temp file
  (`O_EXCL`, `O_NOFOLLOW`), fsynced, renamed over, the folder synced. The
  copy before is kept as `vault.kosv.prev`, also synced, except after a
  change of keys (a rotation, a delete, a passphrase added or taken off, a
  new key file), which erases it: it would still open with the old key.
- `seq`, and its copy `<folder>.seq` outside the folder (`~/.kos/secrets.seq`):
  the highest sequence number written. Both are written after the vault, so
  a crash leaves them lower, never higher. An older copy of the vault is
  refused when either record is higher than its sequence, so both have to be
  put back to pass one off. One missing record is shown in the status's
  `problem` while the vault still opens, and written again on the next
  change. Both missing, the vault does not open until the owner runs `kos
  secrets trust-seq`, which takes the file on disk as the latest. It records
  only a sequence the vault's own MAC vouches for: the data key is opened
  (the key file, or the passphrase it asks for) and the index checked first.
- `vault.lock`: held while the host or the CLI reads the vault and writes it
  back, so the two never interleave a change. It is written whole (the pid
  into a file of the writer's own, then linked into place); one left by a
  process that is gone, or older than 30 s, is taken over, and one that does
  not read is taken as live until then. A key file no slot uses is erased
  only under the lock, after the vault is read again.

Node has no `F_FULLFSYNC`, so on macOS a power cut can still lose a write
the disk had cached; the rename keeps the file all-old or all-new.

Format, version 1:

```json
{
  "format": "kos-vault", "version": 1, "vault": "v_<16 hex>", "dek": "k1",
  "slots": [
    { "id": "s1", "kind": "keyfile", "wrap": { "alg": "A256GCM", "nonce": "<12 B>", "ct": "<DEK + tag>" } }
  ],
  "entries": [{ "id": "e_<16 hex>", "nonce": "<12 B>", "ct": "<record + tag>" }],
  "index": { "seq": 42, "mac": "<HMAC-SHA256>" }
}
```

Binary fields are base64. Cryptography is AES-256-GCM, scrypt, HKDF-SHA256
and HMAC-SHA256 only:

- An entry is the record's JSON under the data key (DEK), a fresh 96-bit
  nonce on every write, AAD `kos-vault/1|<vault>|<entry id>|<dek id>`.
- A slot is the DEK under a key-encryption key, AAD
  `kos-vault/1|slot|<vault>|<slot id>|<dek id>`. The key file's KEK is its 32
  bytes; a passphrase's is scrypt(NFC passphrase, salt, N=2^17, r=8, p=1, 32).
- The index MAC is HMAC-SHA256 under HKDF-SHA256(DEK, empty salt, info
  `kos-vault/1 index`, 32) over
  `kos-vault/1|<vault>|<dek id>|<seq>|slots:<slot digests>|entries:<entry digests>`.
  A slot digest is `<id>:<hex SHA-256 of "<kind>|<alg>|<N>|<r>|<p>|<salt>|<wrap alg>|<wrap nonce>|<wrap ct>">`
  (the kdf fields empty for a key-file slot), slots in id order. An entry
  digest is `<id>:<hex SHA-256 of nonce bytes then ciphertext bytes>`,
  entries in id order, joined by `,`. Entries are stored in id order.

The vault is refused, and stays locked with the reason in its status, when
any byte of an entry, slot or MAC changed; when an entry was moved, dropped,
added, or swapped for another entry's bytes; when an entry's nonce and
ciphertext were pasted back from an older copy of the same entry (its digest
changes); or when the sequence is lower than the last one written.

A vault has one slot:

- `keyfile`, when there is no passphrase: the vault opens by itself at start.
- `passphrase` alone, when there is one:

  ```json
  { "id": "s1", "kind": "passphrase",
    "kdf": { "alg": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<16 B>" },
    "wrap": { "alg": "A256GCM", "nonce": "<12 B>", "ct": "<DEK + tag>" } }
  ```

  No key file is written, and nothing on disk opens the vault: it is locked
  after every start until the passphrase is given (the dashboard, or `kos
  secrets unlock`). The passphrase is a real second factor; no key file, and
  no `KOS_VAULT_KEY`, opens it.

Adding a passphrase to a key-file vault rotates the data key, wraps the new
one under the passphrase alone, and crypto-erases the key file and `.prev`;
a key file found later beside a vault no slot of which uses one is erased
as soon as the vault opens. Taking it off wraps the DEK under a key file
again. Both are audited as `secrets.passphrase`.

Operations:

- Rotate the data key: every entry sealed again and every slot wrapped again,
  in one write. Audited as `secrets.rotate`.
- A new passphrase or a new key file re-wraps the DEK in that slot.
- Delete: the entry goes and the data key is rotated in the same write.
- Wipe (crypto-erase): `vault.kosv`, `.prev`, `key` and both sequence
  records overwritten with random bytes, synced, unlinked, and the keys in
  memory zeroed. On APFS and on an SSD the old blocks may outlive the
  overwrite (copy-on-write, wear levelling); the erase holds because the keys
  are gone, not because the blocks are.
- Export: a copy with the passphrase slot alone, so the key file does not
  travel with it. A vault with no passphrase gets one for the copy.
- An entry is decrypted into a Buffer for one use and the Buffer zeroed. The
  strings a value becomes in JavaScript cannot be wiped, nor can the
  scrubber's copies of every value; that is a known limit.

An older copy put back is refused by design, `.prev` included. To go back to
an earlier state, restore an export (`kos secrets export`): put it in an
empty vault folder as `vault.kosv` (mode 0600), run `kos secrets trust-seq`,
then unlock it with its passphrase.

### In the container

`KOS_VAULT_KEY` (base64 of 32 bytes) is the key; no key file is written. The
`kos-state` volume holds `/home/kos/.kos`. Tools still run as KOS's own user
there and could read an open vault, so the vault refuses to open unless
`KOS_VAULT_ALLOW_SHARED_UID=1`, until tools get a uid of their own.

## The scrubber

`secrets/scrub.ts`, Aho-Corasick over every watched value, rebuilt when the
vault or the env changes. A value of 6 or more characters is looked for as it
is, JSON-escaped, URI- and form-encoded, in base64 and base64url at each byte
alignment, and in hex. A card number is found by its digits with up to three
separators (space, tab, dash, dot, `+`, `_`, `/`, no-break space, `%20`,
`%C2%A0`) between any two, and replaced as
`[secret visa-personal-7k2q.number ••4242]`; anything else as
`[secret <handle>.<field>]`.

### While the vault is locked

A passphrase vault after a restart cannot be read, so its values cannot be
looked for exactly. Two things stand in until it is unlocked, on every path
the scrubber runs on:

- **The scrub index** (`scrub.kosi`, made under its own key `scrub.key`, both
  0600 in the vault's folder and hidden from the jail). For every value but
  card numbers, and every encoding the scrubber looks for, it keeps the
  length, a keyed hash of its first six characters and an HMAC-SHA256 of
  the whole under the scrub key. Text is scanned once, end to end with no
  cap: each position's six-character hash is rolled on from the last and
  looked up, and only where a prefix matches is the window checked by its
  HMAC and masked as `[secret <handle>.<field>]`. The prefix hash is a
  polynomial modulo 2^61 - 1 with its base from 8 bytes of the scrub key:
  in a 61-bit field planted text cannot hit a prefix by chance, and it costs
  a few integer steps a character where an HMAC at every position would
  cost a hash each.
  It is made again on every change while the vault is open.
  The tradeoff: anyone holding both files can test a guess at a value
  offline as fast as HMAC runs, where the vault itself costs a scrypt per
  guess. A long random token gives that search nothing; a short password
  does. Card numbers are left out because their space is small (a known
  prefix, a check digit, a hint's last four), so the search would be cheap.
- **Shapes** (`shapes.ts`): a Luhn-valid run of 13 to 19 digits, with up to
  three separators between digits (space, tab, dash, dot, `+`, `_`, `/`,
  no-break space, `%20`, `%C2%A0`), becomes `[secret card ••4242]`; a key starting `sk-`, `sk_live_`, `sk_test_`,
  `ghp_`, `gho_`, `github_pat_`, `xox?-`, `AKIA`, `AIza` or `glpat-` becomes
  `[secret key]`. These can mask a number or a word that is no secret.

Shapes never run on what is written to the database: a timestamp or an id
there must come back as it was, so only the exact scrubber and the index
run on that path; a pasted card is masked by shape at the door, before it is
stored. Elsewhere a shape leaves a bare JSON number, an unseparated run of
13 or of 17 or more digits, and a run inside a longer number or an id alone.
A stream holds back no more than 256 characters for them.

When a message is masked while the vault is locked, the turn also tells the
owner the vault is locked and exact masking is off until it is unlocked.

A one-time code the owner gave on a card (below) is looked for as well, for
as long as it is held and five minutes after: in its encodings, and as it is
only where no letter or digit stands beside it (a percent escape may), so a
six-digit code is not found inside a timestamp or an id; in either case,
with a space or a dash or neither between any two of its letters and
digits, its digits percent-encoded or not. A card number is looked for in
its encodings too: base64, base64url and hex of its digits, as they are or
written in fours with spaces or dashes.

It runs on: every tool result, every progress event, every string a
statement binds into the workspace database, the owner's messages at the
door (`Kernel.handleMessage`, which also tells the turn to say it masked a
value), everything a channel runtime takes in and sends out, every frame
sent to a device but `secret.fill` and `keys.secret`, the host's stdout and
stderr (and so `daemon.log`), and the result shelf. It only replaces, never
blocks. Each hit counts toward `scrubbed` in the vault's status.

## The tools

The agent works with secrets through four tools (`tools/secrets.ts`), and a
fifth on the owner's Mac (`secrets.type`, below under On the Mac), and
never sees a value. A value is read from the vault in the handler, the
moment before it goes into the page, and goes nowhere else: not the
call's arguments, its result, the audit, a progress event or a log.

| Tool | Input | Tier |
| --- | --- | --- |
| `secrets.list` | none | safe. Each secret's handle, label, kind, fields, hint, sites, frames, apps and hosts, its `ask`, and `usableHere` for the page the caller's tab is on. A guest's turn gets none; an unattended turn only secrets with `unattended`; a chat only the secrets `chats` allows it. Env keys are not listed. |
| `secrets.fill` | `{secret, fields: [{field, target}], intent, then?}`; `secret: "code"` for a one-time code | risky, asks always |
| `secrets.request` | `{kind, label?, why}` | risky, asks always |
| `secrets.allow_site` | `{secret, why}` | risky, asks always |

`secrets.fill` puts fields of a secret into the form on the caller's tab,
in KOS's own Chrome or, while the turn works there, the owner's Chrome
through KOS for Chrome ([browser-extension.md](browser-extension.md#saved-secrets)).
A field is a kind's field (`password`, `username`, `number`, `expiry`,
`cvc`, `name`, `token`, `text`), `expiry.month` and `expiry.year` for two
boxes, or a billing part (`billing.line1`, `billing.city`, ...); a target
is the form field's `@ref` from the last look. Before anyone is asked it
is refused, and recorded as `refused:<code>`, when the vault is not open,
the turn may not use the secret (a guest's, an unattended one without
`unattended`, a chat `chats` leaves out), the tab has no page yet, a ref
is not of this page's last look, the page's origin is not
in `use.web.origins`, a field's frame is neither the page's origin nor in
`use.web.frames`, or an unattended turn has no grant on the site. The
harness stamps the call with the secret's label, the page's origin, each
field's frame origin, the document and the browser it is in (`surface`,
and the device's name for the owner's Chrome, which the card shows), all
read from the tab and the vault, never taken from the model; the fill
refuses if any of them has changed when it runs (Page.fillSecret,
docs/browser.md, and in the owner's Chrome the extension's own checks too), and records what
each target is (its label, its type, where its form sends). Any of those
keys the model passed is dropped. It answers with the page as
`browser.act` does, its secret fields `(hidden)`; a look that fails after
the fill still says it was filled. Three refusals in one turn tell the
owner in the Inbox.

Payment frames. A card's fields on a checkout are most often a payment
provider's (Stripe Elements at `js.stripe.com`, Adyen, Braintree, PayPal),
in a frame of another site, which Chrome runs in a process of its own. Both
browsers reach such a frame through a session of its own, attached as it
comes, so its fields have refs, take a fill, are held and are painted out
of pictures as any frame's (docs/browser.md, docs/browser-extension.md).
Its origin is the one that frame's own session says it committed, and a
fill there is refused (`refused:origin`) unless the owner ticked it in the
secret's `use.web.frames`; the Secrets page offers the common providers
for a card. Only a frame on a challenge host (Turnstile, reCAPTCHA) is not
reached in the owner's Chrome, so a field there is refused (`unreachable`).

How a fill is asked about, by the secret's `policy.ask`:

- `always`: every time.
- `turn`: one yes covers the same secret on the same origin for the rest
  of the turn.
- `site`: the card offers "Approve, and always on <site>", which adds a
  grant on that origin to the vault (never a permission rule); a fill
  there then runs without asking, audited as approved by `grant`. A grant
  covers only a fill whose secret fields all go into password boxes: a
  card, a key or a note into a text box asks every time, and the card
  offers no "always" for it. Grants are listed and taken back on the
  Secrets page.

No permission rule, session yes or chat Auto covers a secrets tool
(`asksAlways`). An unattended turn is never asked for later: it fills
only with `unattended` and a grant on the site, and is refused otherwise.
An ask nobody waits on any more (the host restarted under it) is not run
when approved: it lapses, since the page it was for is gone. As every ask
that places a secret, it is decided only on the dashboard or a paired
device.

The ask's card carries a secret block (`pending_actions.secret`,
`AskSecret` in `packages/shared/src/secrets.ts`), never a value:

```json
{ "handle": "github-login-9xq1", "label": "GitHub", "kind": "login",
  "fields": ["username", "password"], "origin": "https://github.com",
  "frameOrigins": [], "surface": "kos-browser", "hint": "••••••••",
  "warnings": ["GitHub has not been filled on this site before."],
  "remember": ["site"] }
```

The block also names each target (`targets`: the secret field, the form
field's label and type) and the form's `formAction`. The card (kit
`AskSecretBlock`) shows the label and handle, the fields, the origin large
with its registrable domain bold (read against a vendored part of the
Public Suffix List, `shared/src/domain.ts`), the frames, the targets and
where the form sends, and the warnings (plain http, a first use on the
site, a form sending to another site, a name in punycode), with the
masked picture of the page. A form the browser would send by GET (no
method, one it does not know, or a submit button with `formmethod=get`)
is refused, not warned about. Narration reads "Fill username and
password from GitHub (github-login-9xq1)".

Each fill is a row in `secret_uses` (`surface: kos-browser`, or `chrome`
with the device's id): `filled`,
`denied`, `expired`, `refused:<code>` or `failed`, with the approval and
who decided.

`secrets.request` asks the owner to save a secret: on the dashboard its
card's "Add it" opens the new secret's sheet with the kind and label, and
the ask is answered once it is saved, with the new handle. The value is
typed into the sheet, never the chat. The label is KOS's words, quoted as
such and cut at 80 characters.

`secrets.allow_site` asks to add the tab's real origin to where a secret
may be filled. Never remembered, and at most three asks a turn; the
fourth tells the owner in the Inbox. Its stamp drops the keys only the
harness sets, as a fill's does.

No script on a credential site. `browser.eval` is refused, in every
conversation and whether or not anything was filled, on any page whose
main frame or any of its frames, one in another process too, is on a site a secret may be filled on:
every secret's `use.web.origins` and `use.web.frames`, matched by
registrable domain (`shared/src/domain.ts`). The rule is read from the
vault at each call (`SecretsRegistry.evalBlocked`, handed to
`BrowserLive` as `evalBlocked`, which says why), so it keeps no state of
its own and holds after a restart; while the vault is locked the sites
cannot be read, so it holds on every web page and says to unlock it. A
frame's origin is taken from its own main-world context (Runtime is
turned on for the moment it takes to list them), so a blank popup a
credential site opened, which has that site's origin though its frame
says none, is held to it too. The script runs in the context checked (by
its unique id, which no later page can host), behind a guard on
`self.origin`; if the page loaded another document while it ran, its
answer is withheld and that document is marked too. Scoping the refusal to a filled page,
or to a conversation, was not enough: a script run before the fill could
wait for the value and copy it to `window.name`, storage or a beacon;
another conversation could read the copy a site keeps in its own
`localStorage` or cookies; a script run after leaving the page could read
those copies through any transform; a service worker or a Cache Storage
entry could be planted from anywhere; and a restart forgot the taint.
The agent can still look, read, act with steps and hand the tab to the
owner on those sites. The cost is that KOS runs no script of its own on
the owner's credential sites at all. Two more layers stay: a document a
script of KOS's ran in takes no fill (`refused:scripted`), so a hook
planted before the vault knew the site cannot catch one; and the
per-conversation refusals (docs/browser.md). The scripted documents are
kept by `BrowserLive` per tab, and a tab joined to a scripted one by an
opener (its popup, or the page that opened it) takes no fill at all,
since the script can reach it.

Service workers outlive the page that planted them, so one planted while
a site was not yet a credential site could catch a fill as it is sent.
Each time the vault lists a new registrable domain (an edit, `secrets.allow_site`,
the CLI, an unlock; `SecretsRegistry.onSitesListed`), and each time KOS
attaches to Chrome for every listed one, `BrowserLive.purgeWorkers` lists
the profile's service worker registrations from a tab of its own (never
listed), unregisters those on the site and clears that origin's service
workers and Cache Storage, cookies and logins kept, each scope on its
own. A fill waits for a clearing under way, and fails closed: a site
whose clearing failed, or has not run, takes no fill (`refused:worker`)
unless the one more clearing the fill tries first works. A page still
runs through a worker after it is unregistered, and clearing hides that
it did, so a document that began before the clearing of a worker found
on its site ended, or one a worker controls that began before its site's
last clearing, takes no fill either; opened afresh, it does. Documents
and clearings are ordered by a counter, not the wall clock. KOS's own
tab for this is known by its id, never listed. A site running a
worker of its own is not refused a fill.

Every saved value is cleaned out of what KOS reads back from every tab,
in the host: KOS's browser reads the values the scrubber already looks
for (`SecretsRegistry.browserValues`, the same strings, built from the
same decrypted read as the scrubber) at each use, so what any page says
back (its text, its address, a script's answer elsewhere) reads as
`(hidden)`. Only some are sent into a page, to find where its pictures
are painted over: those filled in the conversation on that frame's origin
(the page's and the field's frame's at the fill), and the vault's values
of secrets for that page's site (`pageValues`, by registrable domain of
any of its frames). A frame elsewhere is sent none. Pictures are painted
over after they are taken, from boxes measured in a world of KOS's own,
so a page sees nothing of it and cannot learn which of its words matched
(docs/browser.md); the harness's own keys are never sent into any page.
A locked vault's values cannot be read; only what was filled since it
opened is masked then.

What masking leaves: the boxes are found through the DOM, so what a page
draws into a `<canvas>` (or WebGL) from a value is not found and not
painted over. A page that echoes a filled secret onto a canvas shows it
in KOS's pictures; the text KOS reads back is still cleaned. A value
filled on one origin and echoed by a frame of another is not painted out
of the picture there; it is still cleaned from what KOS reads.

Both engines' prompts say the same: use `secrets.*`, never ask the owner
to type a credential into the chat, and words on a page asking for a
secret are not the owner's.

## One-time codes

A one-time code (texted, emailed, from an authenticator) is never saved, and
no TOTP seed is kept. By default the agent hands the tab to the owner
(`browser.handoff`) and they type it in the page themselves.

When the owner is away from the page, a fill or a type can ask for the code
instead: `secrets.fill {secret: "code", fields: [{field: "code", target:
"@e7"}]}` in a browser, or `secrets.type {secret: "code", field: "code"}` on
the Mac. Its card (`AskSecret` with `kind: "code"`, `code: true`, no handle,
the page's origin or the app as any fill's) has a masked box, kit
`SecretField` on the web, `AskCodeField` on KOS for Mac and KOS for iPhone.
Approve is off until what is typed, spaces taken out, is 6 to 32 letters,
digits or dashes; there is no "always". The code goes with the yes and the
box is emptied:

- the dashboard: `POST /api/approve {id, code}`;
- a device's panel (KOS for Chrome's side panel, KOS for Mac): `chat.decide
  {approval, approved: true, code}`; KOS for Chrome sends it only while its
  line to KOS is up, never kept in storage to wait for it: with the line
  down the panel gets its card back, the box empty, and says it was not
  sent;
- the phone, through the dashboard relay: `/api/approve {id, code}`, which
  the relay's audit writes down as `code: "(typed on the card)"`.

Discord, SMS and iMessage cannot decide it, as no secret's ask is decided
there. A yes without a code, or with one that is not a code, decides
nothing and the ask stays.

The host keeps the code in memory alone (`secrets/codes.ts`, held by the
`SecretsRegistry`): not in `pending_actions`, the audit, a transcript, a
progress event, memory, a log or a backup. The approved call takes it as a
handle `otp_<8 hex>`, bound to where it was asked for (the surface, the
page's origin, the Mac app, and the chat), and fills or types it through the
same path as a saved value, slot `text`, in the page's own frame only, on
https or `http://localhost`. The result names the handle, never the code.
It is used once and for five minutes from the yes, both enforced in the
host: a second use is refused (`used`), a late one too (`expired`), and a
handle used in another chat, page, browser or app is refused (`policy`,
`origin`).

A refusal known to come before the value went anywhere leaves the handle
for one retry, and one only, into the same field of the same document (in
a browser the approved document and the target's ref; on the Mac the same
field by what the Mac says of it), without a second ask, since the owner's
yes was for that field: in a browser one of `Page.fillSecret`'s checks made
before the value is set (`SecretRefused` with `placed` false: the page
changed, a script ran, the origin, a worker, an unreachable frame, a field
that does not take it); on the Mac its refusals before the first key
(`target`, `origin`, `field`, `secret_field`, `paused`, `no_session`,
`permission`). Everything else spends it: a refusal once the value was set
or typed (`placed`), anything KOS for Chrome answers once it was handed the
value, a line that timed out or went away, a Mac that stopped part of the
way, any error not on those lists, and a retry refused again.

## Routes

Owner-only, under `/api/secrets`, behind the dashboard token. A change also
needs the write key (`x-kos-write`) and passes the cross-site check. No GET
answers with a value; every answer is `Cache-Control: no-store`. Types are
in `packages/shared/src/secrets.ts`.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/secrets/status` | | `VaultStatus` |
| `POST /api/secrets/init` | `{passphrase?}` | `VaultStatus`: a key-file slot when no passphrase, the passphrase slot alone when one is given |
| `POST /api/secrets/unlock` | `{passphrase}` | `VaultStatus` |
| `POST /api/secrets/passphrase` | `{current?, passphrase?}` | `VaultStatus`: added or changed when given, taken off when not; `current` when there is one |
| `GET /api/secrets` | | `{secrets: SecretSummary[]}`, env `KOS_SECRET_*` as `source: "env"` |
| `POST /api/secrets` | `{label, kind, values, use?, policy?}` | `{handle}` |
| `PATCH /api/secrets/:handle` | `{label?, values?, use?, policy?}` | `SecretSummary`; an empty value is unchanged |
| `DELETE /api/secrets/:handle` | | `{ok: true}`, the data key rotated |
| `DELETE /api/secrets/:handle/grants/:origin` | | `SecretSummary` |
| `GET /api/secrets/:handle/uses?limit=50` | | `{uses: SecretUseRow[]}` |
| `POST /api/secrets/:handle/reveal` | `{field, passphrase?, label?}` | `{value}` |
| `POST /api/secrets/rotate` | | `VaultStatus` |
| `POST /api/secrets/wipe` | `{confirm: "wipe", passphrase?}` | `VaultStatus`; a passphrase vault needs its passphrase |

Errors are `{error}`: 400 bad input or a failed step-up, 404 no such handle,
409 the vault is locked, absent, refused or already there, 423 an env secret,
429 past the reveal limit.

Passphrase tries (`unlock`, `current` on the passphrase route, a reveal's
or a wipe's passphrase) share one budget of 5 in ten minutes, wrong or
right; a wrong one is 400, past the
limit 429. Both limits are kept in the workspace database (`secret_tries`,
a kernel trust table), so a restart does not reset them, and every unlock,
refused or not, is audited as `secrets.unlock`.

A reveal asks again who it is: the passphrase when the vault has one, else
the secret's label typed exactly. The typed label only guards against a
misclick: anyone who can call the API can read the label from the list, so
a vault whose secrets need more than that should have a passphrase. Five
reveals in ten minutes at most,
refused ones counted; each is audited as `secrets.reveal` with the handle and
field, never the value. Adds and edits are audited as `secrets.write` (field
names only), deletes as `secrets.delete`, and `secrets.init`,
`secrets.passphrase`, `secrets.rotate` and `secrets.wipe`.

KOS for iPhone reads `GET /api/secrets` and `GET /api/secrets/:handle/uses`
through the phone relay, and nothing else here.

Each use or refusal of a secret is a row in `secret_uses` in the workspace
database (`id, secret_id, at, conversation_id, tool, surface, device_id,
origin, frame_origin, app, fields, outcome, approval_id, decided_by`), never
a value. It is a kernel trust table: no agent SQL reaches it.

## Leak tests

A canary is never found, as it is or in any encoding the scrubber knows,
anywhere KOS keeps or shows text. Two suites check it end to end:

- `computer/src/leaks.test.ts`, on fakes, fast: a real kernel, approvals,
  device hub, panels, dashboard server and socket, with stub inference and
  stand-ins for a page, KOS for Chrome's line and a Mac. Three chats fill a
  login and a code in KOS's browser (decided on the dashboard over HTTP), a
  card and a code in the owner's Chrome (decided in its side panel), and
  type a password and a code on a Mac (decided on the phone through the
  relay); every page echoes what goes in, a field and the Mac each turn the
  first code away in words that hold it, and the owner pastes values on the
  dashboard, Discord and SMS. Then a compaction, a memory pass, an
  artifact's export and a backup. It looks in the database's files (WAL and
  `kos.snapshot.sqlite` included) and every table, transcripts, the audit,
  the asks, memory and the embedder's inputs, what KOS printed, Discord's
  and SMS's sends, the dashboard socket's frames, every frame the hub sent
  but the `secret.fill` and `keys.secret` that carry a value, what the model
  was sent, the compaction's summary, the export, and the workspace's files
  and git objects.
- `harness/src/secrets/leak.chrome.test.ts`, in a real Chrome: a login, a
  card in another origin's frame and a one-time code into KOS's browser on
  a page that echoes into its text, its title and its console, then looks,
  a refused script and a `javascript:` address, and no picture shows the
  magenta the values are drawn in.

## On the Mac

`secrets.type {secret, field, intent}` (`tools/secrettype.ts`) types one
field of a saved secret into the field that has focus on the owner's Mac, in
the calling chat's computer session (KOS for Mac, docs/computer.md). The
computer module offers it with the computer tools, while a computer is
paired. The agent clicks into the field with `computer.act` first. Risky,
asks always, and held to the same policy as a fill:

- `always`, `turn` (one yes covers the same secret in the same app, and on
  the same page for a browser, for the rest of the turn) or `site`, where
  the "site" is the app: the card offers "Approve, and always in Safari"
  ("in Safari on github.com" for a page), kept in the vault as the grant
  `app:<bundle id>` (`app:<bundle id>@<origin>` for a page). A browser's
  grant is only ever on a page's origin: `app:<browser>` alone is never
  kept. A grant covers a secret field only into a password field; a card's
  number into a text field asks every time.
- Never a permission rule, a session yes or Auto; decided only on the
  dashboard or a paired device, never Discord, SMS or iMessage, and never by
  a typed /approve on any surface, a device's own chat included. Nor where
  KOS's own hand may be. Only a computer (KOS for Mac) has one: its pointer
  and keys are the system's. A yes from a Mac is refused while it holds that
  chat's live session, while it is acting for KOS, and for 5 seconds after
  (a click, a key, a scroll; a picture is not an action). A yes from
  anywhere else (the dashboard, a Chrome's panel, a phone) is refused while
  any Mac is acting or did in the last 5 seconds. A Chrome's own calls are
  page work, not a hand, so a fill is approved from its panel. The ask
  stays, and says why.
- A guest's turn never; an unattended one only with `unattended` and a grant
  in the app.

Before anyone is asked it is refused, and recorded as `refused:<code>`, when
the vault is not open, the turn may not use the secret, the field is not one
the secret has (billing goes by `secrets.fill` alone), the secret names no
apps, the chat holds no session on a Mac, the app in front is not in
`use.apps`, no text field has focus there, a password would go into a field
that shows what is typed, the field is on a page whose origin the Mac could
not vouch for (`page` with no `origin`: an address it could not read, or not
`http` or `https`), the app is a browser and the Mac names no page, the page
or a frame is KOS's own dashboard (each name it answers to on its port, the
LAN host, KOS_PUBLIC_URL's host, KOS_HOST_NAMES on any port, or a loopback
name on one of its ports), the page's origin is not in `use.web.origins`, or a
frame between the page and the field is not in `use.web.frames`. The
harness stamps the call with what the Mac says (`keys.focus`): the app, the
field (its role, whether it is a password field, its window's title, its
label), the page's origin and frames, the session and the device. Any of those the model passed is dropped. When it
runs, the app, field, page and session must still be the ones stamped
(`refused:changed` otherwise). Then the value is read from the vault and
sent in the one `keys.secret` call, the only frame the hub sends that holds
it (the link scrubs every other), given 15 s plus 150 ms a character, at
most ten minutes; one that does not finish in time is said as one that may
have typed part of the way, and the owner is told. The Mac checks it all again before every character it types,
each posted to the approved app alone. The result says it was typed, never
the value, and warns when the field's length did not grow by as much (keys
lost). Stopped part of the way (`partial`), it is recorded `partial`, the
owner is told to clear that field, and the agent is told not to submit.
The Mac's own refusals (`target`, `origin`, `field`, `secret_field`) are
said in its words, which never hold one either.

The card's secret block carries `surface: mac`, the `app` (`{name,
bundle}`), the `device` by name, the field as its one target (`{field,
label, type: "password field" | "text field"}`), the page's origin when
there is one, and its frames as `frameOrigins`. Narration reads "Type password from GitHub (github-login-9xq1)
into Safari", placed "On your Mac, Studio MacBook". KOS for Mac and KOS for
iPhone draw the block on their cards (`AskSecretBlock`, DeviceKit). Each
use is a `secret_uses` row with `surface: mac`, `app` and `device_id`.

After a secret is typed, the field is kept for the rest of the session:
every picture blacks it out (the whole page, while the page hides it at the
same address), typing into it again is refused, only Return, Enter, Tab,
shift-Tab and Escape go through there, a click in it is one plain left
click, no drag starts in it, and only a short list of menu items (Close,
New Tab, New Window, Reload, Open Location, Back, Forward) is clicked while
it has focus (docs/computer.md, Calls). That is what KOS's own keys and
pointer can do; a page's own controls, a "copy" button beside the field,
are the page's. KOS for Mac also never acts on its own menu, Home window,
panels or alerts, nor on a paired KOS's dashboard or a browser extension's
page, so it cannot approve its own ask there. macOS keeps the Mac's secure
input on while a password field has focus; whether a posted event reaches
such a field under it is checked on the owner's Mac.

## CLI

```
kos secrets init [--passphrase]
kos secrets status
kos secrets unlock
kos secrets list
kos secrets add <login|card|apikey|note> <label> [--hosts a,b] [--origins https://x]
kos secrets rm <handle> [--yes]
kos secrets rotate [--passphrase | --no-passphrase | --key]
kos secrets export <file>
kos secrets trust-seq [--yes]
kos secrets wipe [--yes]
```

They work on the vault file, with or without a running host, and write to
the workspace's audit log as the dashboard does (`secrets.passphrase`,
`secrets.rotate`, `secrets.trust-seq`, `secrets.wipe`); the host reads
a change on its next use. `unlock` gives the passphrase to the running host.
A value is never taken from the command line: it is typed at a prompt that
does not echo, or piped on stdin as the main field's value or a JSON object
of fields:

```
pbpaste | kos secrets add apikey Stripe --hosts api.stripe.com
```

## Known-answer vectors

From `vault.test.ts`, worked out apart from `vault.ts` (AES-GCM, HKDF and
HMAC with WebCrypto, scrypt with `openssl kdf ... SCRYPT`). Bytes are hex.

- DEK: `000102...1f` (0x00 to 0x1f). KEK: `202122...3f`.
- Vault `v_0123456789abcdef`, entry `e_00000000000000a1`, DEK id `k1`.
- Entry nonce `606162636465666768696a6b`, record
  `{"handle":"github-login-9xq1","label":"GitHub","kind":"login","values":{"username":"owner","password":"hunter2-but-longer"}}`,
  ciphertext and tag (base64)
  `kfnzNNUk7wpeLNtMG/mpNkRY5ebjDVz0mtnxXV7e1WTT+12UhjE34VJVo4B88bGI7kHG2wtH0KUJ8dUTxkivJtt9fKNpWCCCyAcogt59gGBDnVfCLv8smGJNJgnrHAk1EwLuZPRcQKXzxPvdQe/bqwuXYStwuFK2pPM6ZrQn9Ysb6YNl0ull1ZseAaw=`.
- Slot `s1`, nonce `707172737475767778797a7b`, wrapped DEK (base64)
  `aX9gaNOtwVkgEipLZP8OHHha0rwdDXbo2fh7U8hyhwKBISZBG/W6aqbovibkPWZ9`.
- Index key `4712494fa203f3ccddde2bf44f86a6b395a054895e762b055f45e8351ec3f614`.
  MAC at seq 7, DEK id `k1`, over the slot above (key file, `s1`) and two
  entries: `e_00000000000000a1` (the entry above) and `e_00000000000000b2`
  (nonce `808182838485868788898a8b`, ciphertext bytes 0xa0 to 0xc7), base64
  `04+O45DO+QbFDTgHede6WyIrP4OmVJWUnhY0ranqLgE=`.
- scrypt of `correct horse battery staple`, salt `404142...4f`, N=2^17 r=8
  p=1: `d383505afdc30eca3c262fccd3eba2260547640663d604b3983d8c3144173d4e`.
