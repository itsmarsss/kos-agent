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
  owner's chats) are kept for the fill tools; guests never get a secret.
- The hint never holds enough of a value to matter: a card's last four, a
  key's last four when it is longer than twelve, eight dots for a login.

## The vault

`~/.kos/secrets/` at mode 0700, or `KOS_VAULT_DIR`. Never in the workspace,
so never in its git snapshots.

- `key`: 32 random bytes as base64, mode 0600, marked to stay out of Time
  Machine (`com.apple.metadata:com_apple_backup_excludeItem`).
- `vault.kosv`: JSON, mode 0600, written atomically (a temp file, fsync,
  rename, the directory synced), with the copy before it kept as
  `vault.kosv.prev`.
- `seq`: the highest sequence number this machine wrote, so an older copy
  put back is refused.

Format, version 1:

```json
{
  "format": "kos-vault", "version": 1, "vault": "v_<16 hex>", "dek": "k1",
  "slots": [
    { "id": "s1", "kind": "keyfile", "wrap": { "alg": "A256GCM", "nonce": "<12 B>", "ct": "<DEK + tag>" } },
    { "id": "s2", "kind": "passphrase",
      "kdf": { "alg": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<16 B>" },
      "wrap": { "alg": "A256GCM", "nonce": "<12 B>", "ct": "<DEK + tag>" } }
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
  `kos-vault/1 index`, 32) over `kos-vault/1|<vault>|<seq>|<entry ids sorted,
  joined by ",">`. Entries are stored in id order.

The vault is refused, and stays locked with the reason in its status, when
any byte of an entry, slot or MAC changed, an entry was moved, dropped,
added or swapped, or the sequence is lower than the last one written.

Slots:

- `keyfile`, always: the vault opens by itself at start.
- `passphrase`, optional: while there is one, the vault is locked after every
  start until the passphrase is given (the dashboard, or `kos secrets
  unlock`). The key-file slot stays, so a passphrase is a lock on the running
  host, not a second factor against someone holding the key file.

Operations:

- Rotate the data key: every entry sealed again and every slot wrapped again,
  in one write. Audited as `secrets.rotate`.
- A new passphrase or a new key file re-wraps the DEK in that slot alone.
- Delete: the entry goes and the data key is rotated in the same write.
- Wipe (crypto-erase): `vault.kosv`, `.prev`, `key` and `seq` overwritten
  with random bytes, synced, unlinked, and the keys in memory zeroed.
- Export: a copy with the passphrase slot alone, so the key file does not
  travel with it. A vault with no passphrase gets one for the copy.
- An entry is decrypted into a Buffer for one use and the Buffer zeroed. The
  strings a value becomes in JavaScript cannot be wiped, nor can the
  scrubber's copies of every value; that is a known limit.

If an old copy must be restored by hand, put `vault.kosv.prev` in place and
delete `seq`.

### In the container

`KOS_VAULT_KEY` (base64 of 32 bytes) is the key; no key file is written. The
`kos-state` volume holds `/home/kos/.kos`. Tools still run as KOS's own user
there and could read an open vault, so the vault refuses to open unless
`KOS_VAULT_ALLOW_SHARED_UID=1`, until tools get a uid of their own.

## The scrubber

`secrets/scrub.ts`, Aho-Corasick over every watched value, rebuilt when the
vault or the env changes. A value of 6 or more characters is looked for as it
is, JSON-escaped, URI- and form-encoded, in base64 and base64url at each byte
alignment, and in hex. A card number is found by its digits with up to two
spaces, dashes or dots between any two, and replaced as
`[secret visa-personal-7k2q.number ••4242]`; anything else as
`[secret <handle>.<field>]`.

It runs on: every tool result, every progress event, every string a
statement binds into the workspace database, the owner's messages at the
door (`Kernel.handleMessage`, which also tells the turn to say it masked a
value), everything a channel runtime takes in and sends out, every frame
sent to a device but `secret.fill` and `keys.secret`, the host's stdout and
stderr (and so `daemon.log`), and the result shelf. It only replaces, never
blocks. Each hit counts toward `scrubbed` in the vault's status.

## Routes

Owner-only, under `/api/secrets`, behind the dashboard token. A change also
needs the write key (`x-kos-write`) and passes the cross-site check. No GET
answers with a value; every answer is `Cache-Control: no-store`. Types are
in `packages/shared/src/secrets.ts`.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/secrets/status` | | `VaultStatus` |
| `POST /api/secrets/init` | `{passphrase?}` | `VaultStatus` |
| `POST /api/secrets/unlock` | `{passphrase}` | `VaultStatus` |
| `GET /api/secrets` | | `{secrets: SecretSummary[]}`, env `KOS_SECRET_*` as `source: "env"` |
| `POST /api/secrets` | `{label, kind, values, use?, policy?}` | `{handle}` |
| `PATCH /api/secrets/:handle` | `{label?, values?, use?, policy?}` | `SecretSummary`; an empty value is unchanged |
| `DELETE /api/secrets/:handle` | | `{ok: true}`, the data key rotated |
| `DELETE /api/secrets/:handle/grants/:origin` | | `SecretSummary` |
| `GET /api/secrets/:handle/uses?limit=50` | | `{uses: SecretUseRow[]}` |
| `POST /api/secrets/:handle/reveal` | `{field, passphrase?, label?}` | `{value}` |
| `POST /api/secrets/rotate` | | `VaultStatus` |
| `POST /api/secrets/wipe` | `{confirm: "wipe"}` | `VaultStatus` |

Errors are `{error}`: 400 bad input or a failed step-up, 404 no such handle,
409 the vault is locked, absent, refused or already there, 423 an env secret,
429 past the reveal limit.

A reveal asks again who it is: the passphrase when the vault has one, else
the secret's label typed exactly. Five reveals in ten minutes at most,
refused ones counted; each is audited as `secrets.reveal` with the handle and
field, never the value. Adds and edits are audited as `secrets.write` (field
names only), deletes as `secrets.delete`, and `secrets.init`, `secrets.rotate`
and `secrets.wipe`.

KOS for iPhone reads `GET /api/secrets` and `GET /api/secrets/:handle/uses`
through the phone relay, and nothing else here.

Each use or refusal of a secret is a row in `secret_uses` in the workspace
database (`id, secret_id, at, conversation_id, tool, surface, device_id,
origin, frame_origin, app, fields, outcome, approval_id, decided_by`), never
a value. It is a kernel trust table: no agent SQL reaches it.

## CLI

```
kos secrets init [--passphrase]
kos secrets status
kos secrets unlock
kos secrets list
kos secrets add <login|card|apikey|note> <label> [--hosts a,b] [--origins https://x]
kos secrets rm <handle> [--yes]
kos secrets rotate [--passphrase | --key]
kos secrets export <file>
kos secrets wipe [--yes]
```

They work on the vault file, with or without a running host; the host reads
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
- Index key `4712494fa203f3ccddde2bf44f86a6b395a054895e762b055f45e8351ec3f614`;
  MAC at seq 7 over `e_00000000000000a1,e_00000000000000b2` (base64)
  `M1H7i7WkMPCKg240K9irnW//odtq1qMJL+Kp3fXZrg0=`.
- scrypt of `correct horse battery staple`, salt `404142...4f`, N=2^17 r=8
  p=1: `d383505afdc30eca3c262fccd3eba2260547640663d604b3983d8c3144173d4e`.
