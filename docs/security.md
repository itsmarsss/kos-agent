# Security

What keeps KOS safe, every security problem an audit has found and how it
was fixed, and where prompt injection can still reach. Every PR gets a
separate audit before it merges; each finding lands here.

## The layers

1. **Risk tiers.** Every tool call is judged safe, risky or beyond Auto
   (`risk/tiers.ts`). Risky asks unless Auto or a saved yes covers it; beyond
   Auto always asks. Some calls are *never learned*: no saved yes, burst or
   job rule ever covers them (sends to a person, deletes, money, KOS's own
   tables, guest-visible posts, every Google write).
2. **The fence.** Projects reach only their own tables and folders; guests
   reach only their room (`tools/fence.ts`, `inScopeFor`). sql runs one
   SELECT, INSERT, UPDATE or DELETE; schema goes through `systems.migrate`;
   only nine read pragmas run, in Maintenance.
3. **The jail.** Shell, skills, daemons and third-party servers run in
   `sandbox/jail.ts`: no reads of `~/.kos`, the vault or other secrets, no
   access to KOS's own ports.
4. **The vault.** Keys live encrypted (`secrets/`), placed into a call only
   for the host they belong to, scrubbed from every result, log and transcript.
5. **Untrusted fencing.** Text from pages, files, mail, apps and MCP servers
   is wrapped by `fenced()` (`context/shelf.ts`) as "not instructions", with
   anything that imitates a turn or the owner defused.
6. **Who is speaking.** Only the owner's own turns carry owner reach; guests,
   schedules, blobs and KOS's maintenance each have their own sender kind.
7. **Audits.** A separate reviewer attacks every PR before merge.

## Findings log

Severity is the auditor's. "Injection" marks findings that untrusted text
could have triggered.

| Date | PR | Sev | Finding | Fix |
|---|---|---|---|---|
| Nov 23 | #613 | M | A vault could be forged: records carried no commitment to the data key. | DEK commitments in seq records. |
| Nov 23 | #613 | M | Unlock at login did not need the passphrase. | It does. |
| Nov 23 | #613 | L | A legacy v1 keyfile left a forgery window until the next unlock. | Records rewritten on the first verified open. |
| Nov 23 | #611 | M | Approval #742 was decided with no record of which surface decided it. | `decided_via` on every settle path; orphaned asks lapse. |
| Nov 24 | #617 | H | A blob thread's Discord gate read one channel's audience while posts went to another, so owner-only work could reach a guest channel. | Gate fails closed: own, project and blob audiences must all be the owner's. |
| Nov 24 | #617 | L, injection | A blob's answer card was stored as KOS's own words, unscrubbed. | Scrubbed, capped, quoted as the blob's. |
| Nov 25 | #620 | M | A scheduled job could fail a step, then declare "nothing to post" and read healthy. | Quiet counts only when nothing else failed; refusals are audited as failed steps. |
| Nov 25 | #620 | M | One run could be credited with another run's posts. | Audit rows carry the turn; counting is per turn. |
| Nov 25 | #621 | L | A secret's ask showed the "runs unattended" warning though it lapses; the iPhone offered lock-screen Approve on unattended asks. | Warning only when a yes really runs; no lock-screen Approve. |
| Nov 25 | #624 | M | Maintenance fix prompts were written in the owner's voice and mirrored under the owner's name. | New sender kind `kos`; never remembered or cited as the owner's words. |
| Nov 26 | #625 | H | A 15-minute burst let writes to KOS's own tables through after one approval. | Kernel-table writes are never learned. |
| Nov 26 | #625 | H, injection | The LeetCode job reads guest-supplied rows and posts to a guest-visible channel; a saved yes would have let injected text post the owner's data there. | Guest-visible posts always ask; never learned. |
| Nov 26 | #625 | M | The owner-only channel check trusted a partial member cache, failing open for an uncached admin. | One fail-closed check: any non-KOS Administrator role means "not yours alone". |
| Nov 26 | #625 | M, injection | A learned yes on a browser step skipped the checkout check. | Checkout rechecked before any learned yes. |
| Nov 26 | #625 | M | A job's saved yes could cover a whole tool (e.g. an MCP git push). | No whole-tool job rules. |
| Nov 26 | #625 | M | A plain Approve silently became standing consent. | Approve runs once; "Always ... for this schedule" saves. |
| Nov 26 | #625 | M | Bursts ignored the folder fence. | Bursts stay within the turn's folder. |
| Nov 26 | #625 | M, injection | A skill's yes covered its code after an edit. | Skills are never learned; only promotion (hash-checked) runs them unasked. |
| Nov 26 | #625 | M, injection | Quoted identifiers hid a DELETE from the delete check. | Deletes judged by SQLite's plan and by raw words. |
| Nov 26 | #625 | M | EXPLAIN compiled PRAGMAs, which change settings at compile time, for any caller (present on main). | EXPLAIN only for SELECT/INSERT/UPDATE/DELETE/REPLACE/WITH/VALUES. |
| Nov 26 | #627 | L | Setter pragmas off the deny-list ran in Maintenance; EXPLAIN PRAGMA got past the allow-list. | Allow-list of nine read pragmas; EXPLAIN PRAGMA refused. |
| Nov 26 | #628 | H, injection | Google "change" writes could share into a folder someone else owns, fetch any URL, or touch other people's calendars, unasked under Auto. | Every Google write asks, is beyond Auto, never learned; the card says when it reaches a person. |
| Nov 26 | #628 | M, injection | Trash could be disguised as a label change or a string "true". | Any spelling of TRASH or truthy `trashed` is a delete. |
| Nov 26 | #628 | M | The OAuth callback port was reachable by jailed programs; stateless callbacks allowed login CSRF. | Port jailed; expected account checked; others revoked. |
| Nov 26 | #628 | M | The Google server ran unjailed with floating dependencies. | Frozen with `--exclude-newer`, run in the jail. |
| Nov 26 | #628 | M | "Changes, no sending" still granted Gmail send scopes; sql could flip the switches. | Mail writing is one switch with sending; switches out of sql's reach. |
| Nov 26 | #628 | M | KOS followed symlinks the jailed server could plant (could empty the database). | In progress: lstat, regular files only, settings outside the server's tree. |
| Nov 26 | #628 | M, injection | The model could choose which Google account a call used. | In progress: any other account refused or stripped. |

## Prompt injection

Prompt injection is text KOS reads that tries to make it act. KOS cannot
make a model ignore text reliably, so the defense is to make sure text alone
can never get an action past the owner.

### Where untrusted text gets in

- Web pages (browser, Chrome, http.fetch) and page artifacts' errors.
- Mail, calendar events, Drive files and Docs (Google).
- Discord and iMessage messages from guests, and guest-supplied table rows
  (e.g. LeetCode usernames).
- Files in the workspace, uploads, skill output, daemon output, kos.log.
- MCP server results, tool errors, a blob's or another chat's reply.

### What holds today

- Untrusted text is fenced and labelled as data on both engines.
- Risk is judged from the tool and its arguments, never from what a result
  says, so reading something cannot by itself widen permissions.
- Everything that reaches another person, deletes, spends, or changes KOS
  itself asks the owner and is never covered by a saved yes.
- Guests cannot use owner tools or the owner's reach.

### Gaps

- A safe read followed by a write the owner approves: the card shows the
  action, not that untrusted text suggested it.
- Data can still leave through an approved action whose arguments carry it
  (a URL, a file body), if the owner approves without reading closely.
- Saved yeses and Auto apply the same whether or not the turn read untrusted
  text first.

### Ways to stay away from it (brainstorm, ranked)

1. **Taint the turn.** Once a turn has read untrusted text, Auto, bursts and
   saved yeses stop covering anything that sends, writes outside the
   workspace or reaches the network; those ask. Reading stays free. This is
   the single biggest cut, cheap to build on the risk tiers that exist.
2. **Say why on the card.** An approval card names the untrusted source the
   turn read ("after reading an email from x@y") so the owner sees when an
   action was suggested by content.
3. **Spot copied arguments.** When an argument value (an address, a URL, a
   folder id, a long text body) appears verbatim in untrusted text the turn
   read, flag it on the card and never let a learned yes cover it.
4. **Egress allow-list.** Only known hosts are reachable; any new host asks.
   Extend it to every tool that fetches (Google imports, attachments, page
   images), not only http.fetch.
5. **A quarantined reader.** Untrusted text goes to a second model with no
   tools that returns only structured fields (dates, amounts, a summary);
   the acting model never sees the raw text. Strongest defense, most work;
   worth it for mail first.
6. **No private data out in a tainted turn.** Memory, secrets, private files
   and owner tables cannot flow into a send or an external write in the same
   turn as an untrusted read without an ask that shows the data.
7. **Expiring yeses.** Saved yeses lapse after a set time unless used, and
   Settings lists them with when each was last used.
8. **Fixed-text jobs.** Jobs that post on a schedule post from a template
   with fields, not free model text, when they read guest-supplied data.
9. **An injection test suite.** A corpus of hostile pages, mails and rows run
   against both engines in CI, asserting no unasked send, write or reach.
10. **Alerts.** A burst of asks, a new host, or a send right after an
    untrusted read raises a notice to the owner.

Recommended next: 1, 2 and 9 together, then 3 and 4.
