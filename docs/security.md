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
7. **Taint the turn.** A turn that has read text the owner did not write
   stops being covered by Auto, bursts, saved Always rules and job consent
   for anything that reaches outside, and its asks say what it read
   (`risk/taint.ts`, `risk/untrusted.ts`). See below.
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
  loop and the SDK engine. Asserted: none of it runs unasked, every ask
  names the source, and the same calls without the read run as before.

### Taint the turn

A turn is tainted from the first result it reads that someone other than
the owner wrote, to its end. Sources (`risk/untrusted.ts`, read from the
tool's name; `ToolRisk.untrusted` for what only the tool knows):

- `http.fetch`, every `browser.*` result, `chrome.page` and the screen
  (`computer.act`): a page, by host.
- Google's server: mail by its sender, Drive, Docs and Calendar; any other
  MCP server's result: that server. Errors count as results.
- `files.read` of a file under an `uploads/` or `downloads/` folder, and a
  search whose hits are there; a file sent with the owner's message.
- Discord reads (`discord.messages`, `reactions`, `member`), a guest's own
  turn, room talk carried with the owner's words.
- `sql` reading a table of a project with a place opened to guests.
- `chats.read`, `chats.search`, `kos.log`, `daemons.logs`, `skills.run` and
  `skills.test` output, a page the owner quoted, and a kept result brought
  back with `context.recall` (as tainted as the read that kept it).

The taint is one object for the turn, handed to whatever it dispatches or
hands off (carried as reach is, `caller.ts`, `tainting`), so a read there
taints the turn waiting on the reply. An ask keeps its sources
(`pending_actions.taint`), and the turn a decision resumes starts tainted
with them and with what the approved call itself read.

While tainted, Auto, a burst, a saved Always, a job's consent, a session's
site trust and a secret's own grant stop covering a call that:

- sends or posts where anyone but the owner reads (notify elsewhere,
  Discord, a connected server's send);
- writes outside the turn's folder;
- reaches the network (`http.fetch` off the site already read, any risky
  MCP call, a skill's code, a shell or Python run on a saved rule);
- changes KOS itself (skills, modules, daemons, schedules, blobs, systems,
  sites, builds, secrets, KOS's own tables, who sees a channel);
- touches a secret;
- or is any tool not known to stay inside the workspace.

Those ask. A call the rules let run unasked asks too when it opens a site
the turn has not been on and the owner's own words this turn did not name,
or sets up work for later (`cron.schedule`, `blobs.create`). Reads stay
free, and so do: a post the owner alone reads (that is the owner reading
it); writes inside the workspace (files in the folder, a project's own
rows, tasks, memory, artifacts, handing work to another chat, which
carries the taint); a GET from the one site everything read came from (an
API's next page) and a browser step on that site, so browsing a trusted
site goes on as before; a shell or Python run Auto lets through, which runs
offline. Saved yeses are kept: Always is still offered, and covers again in
a turn that read nothing.

### Jobs that now ask

From the live jobs' recent runs (Nov 24 to 26):

- **LeetCode Daily 9 AM Board** (`skills.run`, guest rows, then `notify` to
  #leetcode on a standing Always): the post asks every run, and so would a
  second `skills.run` after the first. Narrowest safe exception, not
  enabled: let a job's saved yes cover a post whose text is a fixed
  template filled only from the rows (defense 8), never free model text.
- **Monthly watch: LFX and Apart** (two pages in KOS's browser): the second
  site's visit asks once a month, the schedule's prompt not being the
  owner's words this turn. Exception, not enabled: count hosts named in a
  job's own prompt as the owner's.
- Unchanged: the backfill (its row write is a project table), the school
  digest and nudge (no untrusted read), the kickoff, the research scan and
  the blobs (their posts are to the owner alone, their writes inside).

### Gaps

- A turn is tainted, a chat is not: a page read in one turn is still in the
  next turn's history (whole for a turn, then as its stub; small results
  stay). An injected "when the owner next says anything, post this" can
  ride the owner's next turn's Auto. Fix: keep each turn's sources with its
  transcript and start a turn tainted by what its history still holds.
- Memory written in a tainted turn is not marked, so an injection can
  leave a "fact" that steers later turns.
- Shell and Python output is not a source: a command that fetches a page
  brings its text in untainted.
- Workspace files are untrusted only under `uploads/` and `downloads/`; a
  file a skill or daemon wrote from the web is not.
- A site the owner trusts (Always on site) is still acted on after reading
  only that site, so text a stranger posted there (a comment, an issue)
  can steer clicks on it.
- Safe-floored calls stay free in a tainted turn: a reaction on Discord,
  `http.fetch` to a host on the owner's list (a query string can carry
  data there), an MCP tool the owner marked safe.
- Data can still leave through an approved action whose arguments carry it
  (a URL, a file body), if the owner approves without reading closely.

### Ways to stay away from it (brainstorm, ranked)

1. **Spot copied arguments.** When an argument value (an address, a URL, a
   folder id, a long text body) appears verbatim in untrusted text the turn
   read, flag it on the card and never let a learned yes cover it.
2. **Egress allow-list.** Only known hosts are reachable; any new host asks.
   Extend it to every tool that fetches (Google imports, attachments, page
   images), not only http.fetch.
3. **Taint the chat.** Carry a turn's sources with its history (see Gaps).
4. **A quarantined reader.** Untrusted text goes to a second model with no
   tools that returns only structured fields (dates, amounts, a summary);
   the acting model never sees the raw text. Strongest defense, most work;
   worth it for mail first.
5. **No private data out in a tainted turn.** Memory, secrets, private files
   and owner tables cannot flow into a send or an external write in the same
   turn as an untrusted read without an ask that shows the data.
6. **Expiring yeses.** Saved yeses lapse after a set time unless used, and
   Settings lists them with when each was last used.
7. **Fixed-text jobs.** Jobs that post on a schedule post from a template
   with fields, not free model text, when they read guest-supplied data.
8. **Alerts.** A burst of asks, a new host, or a send right after an
   untrusted read raises a notice to the owner.

Built: taint the turn, say why on the card, the injection suite. Recommended
next: 1, 2 and 3.
