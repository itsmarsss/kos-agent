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
7. **Taint the turn and the chat.** A turn that has read text the owner did
   not write stops being covered by Auto, bursts, saved Always rules, job
   consent, site sessions and secret grants for anything that reaches
   outside, and its asks say what it read (`risk/taint.ts`,
   `risk/untrusted.ts`). The chat keeps the taint until the owner trusts it
   again (`kernel/chattaint.ts`). See below.
8. **Audits.** A separate reviewer attacks every PR before merge.

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
| Nov 26 | #628 | M | KOS followed symlinks the jailed server could plant (could empty the database). | lstat and O_NOFOLLOW, regular files only; settings outside the server's tree. |
| Nov 26 | #628 | M, injection | The model could choose which Google account a call used; a foreign token stayed usable until reload. | Any other `user_google_email` refused; foreign tokens revoked before start and as they land. |
| Nov 26 | #628 | M | The jailed server could remove one of its folders and put a link in its place between KOS's check and its open. | Each folder entry denied to the jail (bubblewrap binds it); KOS acts only in the folder it opened, on files with one name. |
| Nov 26 | #628 | L | Server logs grew unbounded with no file-size cap; attachments and logs outlived a disconnect. | 25 MB cap, WARNING logs emptied past 5 MB, all cleared on disconnect. |
| Nov 26 | #628 | L | The sign-in tab kept a handle back to the dashboard. | Opened with noopener. |
| Nov 26 | #628 | L, injection | Mail quoting the sign-in prompt was replaced; a reworded prompt would show the link. | Replaced only at the start, or when it carries the owner's client's OAuth URL. |
| Nov 26 | #628 | L | Unknown Google tools could run under Auto. | Unknown tools are beyond Auto and never learned. |
| Nov 26 | #628 | L | A KOS_GOOGLE_DIR outside ~/.kos was readable by the jail. | It and its settings file are in the jail's secret files. |
| Nov 26 | #628 | L | Two ways to connect Google (old catalog picks). | Picks and their setup code removed. |
| Nov 26 | #628 | L | The server ran unjailed without saying so when uvx or the jail was missing. | Refused on macOS; elsewhere shown as "running without the jail". |
| Nov 26 | #628 | L | The jail opened all of ~/.local/bin to the server. | Only uv and uvx. |
| Nov 26 | #628 | L, injection | camelCase or capitalised keys (addLabelIds, TRASHED, userGOOGLEEmail) escaped the rules. | Keys normalised with the server's own camel_case regex. |
| Nov 26 | taint | M, injection | Saved yeses and Auto applied the same after a turn read a page, an email or guest rows: injected text could ride an Always (the LeetCode board's post to a guest channel ran on a standing Always after reading guest rows, though #625 made such posts never learned). | Taint the turn: no saved yes covers a call that reaches outside after an untrusted read. |
| Nov 26 | taint | M, injection | Opening a page in KOS's browser was safe whatever the host, so a page could have data sent out in an address. | In a tainted turn a step to a site the turn has not been on asks, unless the owner's own words named it. |
| Nov 26 | taint | M, injection | `cron.schedule` and `blobs.create` ran unasked from any turn, so injected text could set up work that repeats it. | They ask in a tainted turn. |
| Nov 26 | taint | L, injection | An approval card showed the action, never that content suggested it. | Every surface's card says "After reading: ..." for an ask a tainted turn raised. |
| Nov 26 | #630 | H, injection | A page's own site counted as known once read and owner data reads did not count, so a page could have its turn recall memory and open its own site with the data in the address, under Auto or an Always; a stranger's text on a trusted site (GitHub, Reddit, Gmail web) drove the owner's session there; URLs in typed text or a script were unseen. | A private-read bit (memory, the owner's files, tables, chats, secrets list, artifacts) drops the same-site exception; in a tainted turn an address with a query or fragment, or a path no read text linked, asks, wherever in the call it is; acting on a page needs the owner to have named the site this turn. |
| Nov 26 | #630 | H, injection | Any word of three letters or more the owner said named a site on any TLD ("what" allowed what.xyz). | Only a domain or an address the owner wrote, whole. |
| Nov 26 | #630 | H, injection | `improve.suggest` ran unasked in a tainted turn and stored a hidden action; "Do it" ran it in a fresh, untainted turn under saved yeses. | Raised in a tainted turn; the suggestion keeps the taint and the turn a yes opens starts with it; the Inbox shows the action. |
| Nov 26 | #630 | H, injection | A tainted turn could pin a claim in memory, reaching every chat, and cite the owner's events to pass it off as theirs. | Claims from a tainted turn are external, unpinnable and cite nothing; an owner-trust claim must hold words of an event it cites; memory pages, merges, forgets and archives ask. |
| Nov 26 | #630 | H, injection | An owner-only Discord post could carry data out in a card's picture, thumbnail or link, which Discord fetches; iMessage fetches link previews. | From a tainted turn or chat: no card link or picture, addresses in angle brackets on Discord and written as no link on iMessage. |
| Nov 26 | #630 | H, injection | Taint ended with the turn while the page's text stayed in the history, so "thanks, carry on" next turn ran untainted. | Taint the chat: each turn's sources are kept with it and later turns start tainted, through forks, asides and summaries, until the owner trusts it again (header button, `/trust`) or clears it. |
| Nov 26 | #630 | M, injection | Untainted sources: a Discord reply to someone else's message, the Chrome panel's tab and the Mac's window titles, shell or Python reading uploads or downloads, `workspace:` and capitalised paths, multi-line search hits, tab titles, rows a tainted turn wrote, artifacts, a recalled guest row, an approved call's guest rows. | All taint; tables a tainted turn writes are kept and taint whoever reads them. |
| Nov 26 | #630 | M, injection | A root chat wrote anywhere in the workspace unasked while tainted, a prompt skill's SKILL.md included. | In a tainted turn a root chat's writes outside `scratch/` ask; a prompt skill's instructions taint the turn until the owner keeps them as they are (`skills.commit`, by hash). |
| Nov 26 | #630 | M, injection | Auto's shell was exempt as offline, but its jail is local and loopback proxies reach out. | No Auto exemption for programs in a tainted turn. |
| Nov 26 | #630 | M | Four guards had no test that failed without them (site session, learned yes, burst, a denial's resume). | Tests for each. |
| Nov 26 | #630 | L, injection | The card line kept line separators and direction marks. | Stripped, the rest shown as code points. |

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
  itself asks the owner and is never covered by a learned yes.
- Guests cannot use owner tools or the owner's reach.
- **Taint the turn** (below): after an untrusted read, nothing the owner
  said yes to earlier covers a call that reaches outside.
- **Say why on the card**: an ask a tainted turn raised names what it read,
  on the dashboard, Discord, iMessage and SMS, KOS for Chrome, Mac and
  iPhone (one line, `taintLine` in `@kos/shared`, scrubbed and short).
- **An injection test suite** (`kernel/injection.test.ts`, in CI): hostile
  text from a page, an email, a document, a guest in the room, a guest's
  table row, a tool's error and an MCP result, each telling a model that
  obeys it to send the owner's data out, write outside the chat's folder,
  open the attacker's site, schedule itself, or place a secret, on the API
  loop and the SDK engine; also a fetch on a saved Always, a shell under
  Auto, a suggestion, a pinned claim, the page's own site sent memory in
  an address, and a second turn ("thanks, carry on") after the read.
  Asserted: none of it runs unasked, every ask names the source, and the
  same calls without the read run as before.

### Taint the turn

A turn is tainted from the first result it reads that someone other than
the owner wrote, to its end. Sources (`risk/untrusted.ts`, read from the
tool's name; `ToolRisk.untrusted` for what only the tool knows):

- `http.fetch`, every `browser.*` result (tab titles included),
  `chrome.page` and the screen (`computer.act`): a page, by host.
- Google's server: mail by its sender, Drive, Docs and Calendar; any other
  MCP server's result: that server. Errors count as results.
- A file under an `uploads/` or `downloads/` folder however it is spelled
  (`workspace:`, any case), read, found by a search, or named by a shell
  or Python run; a file sent with the owner's message; an artifact.
- A prompt skill's instructions until the owner keeps them as they are
  (`skills.commit`, pinned by hash as a script skill is).
- Discord reads, a guest's own turn, room talk, a reply quoting someone
  else's message, the Chrome panel's tab and the Mac window's title.
- `sql` reading a table of a project with a place opened to guests, or a
  table a tainted turn wrote (kept in `taint.tables`).
- `chats.read`, `chats.search`, `kos.log`, `daemons.logs`, `skills.run` and
  `skills.test` output, a quoted page, and a kept result brought back with
  `context.recall` (as tainted as the read that kept it).

A turn also notes when it read the owner's own data (memory, their files,
tables, chats, the secrets list, artifacts): with that and outside text in
one turn, no site counts as the page's own any more.

The taint is one object for the turn, handed to whatever it dispatches or
hands off (carried as reach is, `caller.ts`, `tainting`), so a read there
taints the turn waiting on the reply. An ask keeps its sources
(`pending_actions.taint`), and the turn a decision resumes starts tainted
with them and with what the approved call itself read. A suggestion keeps
them too, and the turn its "Do it" opens starts with them.

While tainted, Auto, a burst, a saved Always, a job's consent, a session's
site trust and a secret's own grant stop covering a call that:

- sends or posts where anyone but the owner reads (notify elsewhere,
  Discord, a connected server's send);
- writes outside the turn's folder, or, for a chat at the workspace root,
  outside `scratch/`;
- reaches the network (`http.fetch` other than reading on at an address
  the site it came from linked, any risky MCP call, a skill's code, a shell
  or Python run, Auto's included);
- changes KOS itself (skills, modules, daemons, schedules, blobs, systems,
  sites, builds, secrets, KOS's own tables, who sees a channel) or what it
  remembers (memory pages, merges, forgets, archives);
- touches a secret;
- or is any tool not known to stay inside the workspace.

Those ask. A call the rules let run unasked asks too when it opens an
address that could carry what the turn read: a site nobody named, a query
or a fragment, or a path no text it read linked, wherever in the call the
address is (a script, text typed into a form). An address the owner wrote
is theirs, and a site is named only by a domain or an address written
whole. So do a root chat's writes outside `scratch/`, and work set up for
later (`cron.schedule`, `blobs.create`, `improve.suggest`). A risky step
on a page is covered only on a site the owner named this turn, after
reading only that site and nothing of theirs.

Reads stay free, and so does a post the owner alone reads, without its
card's link or pictures and without previews. `memory.remember` runs, but
its claim is kept as outside text's: external, unpinned, citing nothing.
Saved yeses are kept: Always is still offered, and covers again in a clean
turn.

### Taint the chat

A turn's sources are kept with its chat (`chat_taint`, out of sql's
reach), and every later turn there starts tainted with them: the page's
text is still in the history, in a summary written from it, or restated by
the SDK engine. A fork carries them; an aside borrows them with the
history it reads. The chat header says "Read outside text" while it holds
any, with "Trust this chat again"; `/trust` does the same from Discord or
the dashboard, never from a text message; `/clear` and a new chat end it.
A chat's answers on Discord and iMessage go without link previews while it
is tainted.

### Jobs that now ask

From the live jobs' recent runs (Nov 24 to 26). A job's runs share its
chat, so once a run reads outside text every later run starts tainted.

- **LeetCode Daily 9 AM Board**: its post to #leetcode asks every run, and
  from the second run on so does its first `skills.run`. Narrowest safe
  exceptions, not enabled: start each run of a job from no history, so one
  run's reads do not taint the next; and let a job's saved yes cover a post
  that is a fixed template filled only from the rows (defense 7).
- **Monthly watch: LFX and Apart**: the second site's visit, and any page
  neither linked, asks once a month. Exception, not enabled: count
  addresses written in a job's own prompt as the owner's.
- Unchanged: the backfill (its row write is a project table), the school
  digest and nudge, the kickoff (its fetches are to hosts on the owner's
  list, which stay safe), the research scan (its skill is promoted, so
  safe) and the blobs (their posts are to the owner alone, their writes
  inside their folders).

### Gaps

- A host on the owner's `http.fetch` list is reached unasked in a tainted
  turn, query and all: data can reach that host's logs.
- A skill or daemon that writes the database itself (node:sqlite) leaves
  rows a later turn reads untainted; so does a file a tainted turn wrote.
- Shell and Python output is a source only when the command names
  `uploads/` or `downloads/`: one that fetches a page brings its text in
  untainted (it asks to run, in a tainted turn, but not in a clean one).
- Safe-floored calls stay free: a reaction on Discord, an MCP tool the
  owner marked safe.
- The injection suite drives browser steps through a stand-in tool; the
  real KOS browser path with a tab's site is covered by the guard's tests,
  not end to end.
- Data can still leave through an approved action whose arguments carry it
  (a URL, a file body), if the owner approves without reading closely.

### Ways to stay away from it (brainstorm, ranked)

1. **Spot copied arguments.** When an argument value (an address, a URL, a
   folder id, a long text body) appears verbatim in untrusted text the turn
   read, flag it on the card and never let a learned yes cover it.
2. **Egress allow-list.** Only known hosts are reachable; any new host asks.
   Extend it to every tool that fetches (Google imports, attachments, page
   images), not only http.fetch.
3. **A quarantined reader.** Untrusted text goes to a second model with no
   tools that returns only structured fields (dates, amounts, a summary);
   the acting model never sees the raw text. Strongest defense, most work;
   worth it for mail first.
4. **No private data out in a tainted turn.** Memory, secrets, private files
   and owner tables cannot flow into a send or an external write in the same
   turn as an untrusted read without an ask that shows the data.
5. **Expiring yeses.** Saved yeses lapse after a set time unless used, and
   Settings lists them with when each was last used.
6. **Fixed-text jobs.** Jobs that post on a schedule post from a template
   with fields, not free model text, when they read guest-supplied data.
7. **Alerts.** A burst of asks, a new host, or a send right after an
   untrusted read raises a notice to the owner.

Built: taint the turn and the chat, say why on the card, the injection
suite. Recommended next: 1 and 2.
