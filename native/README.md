# Native helpers

Each sensitive domain is a **separate compiled executable** so it becomes its
own TCC-responsible process (DESIGN.md §2, §3.5). This lets macOS show and
revoke each permission independently, and confines Full Disk Access to Messages.

Status:
- `eventkit-helper/`  — Swift, EventKit (Calendar + Reminders)    ✅ M1
- `contacts-helper/`  — Swift, Contacts.framework                 ✅ M3
- `notes-jxa/`        — fixed JXA template run by osascript       ✅ M3
- `mail-jxa/`         — fixed JXA template run by osascript       ✅ M4
- `messages-jxa/`     — fixed JXA send template                   ✅ M4
- messages reads      — sqlite child (`src/native/messages-helper-child`, FDA) ✅ M4

## Contract

Helpers are **resident processes** speaking NDJSON over stdio: one JSON
request per line on stdin, one JSON response per line on stdout. Untrusted
fields are used exclusively as typed API arguments — never concatenated into
AppleScript/shell text, and never placed in argv (argv is visible in `ps`).

```
request:  {"id": 1, "op": "calendar.list_events", "args": {"from": "...", "to": "..."}}
success:  {"id": 1, "ok": true, "data": ...}
failure:  {"id": 1, "ok": false, "error": {"code": "...", "message": "...", "hint": "..."}}
```

Error codes: `permission_denied` (with an actionable hint), `not_found`,
`invalid_request`, `internal`.

## eventkit-helper

Build (requires Xcode command line tools):

```bash
npm run build:native
# → native/eventkit-helper/.build/release/eventkit-helper
```

Ops: `ping` (no TCC — used by CI), `calendar.list_calendars`,
`calendar.list_events`, `calendar.create_event`, `calendar.update_event`,
`calendar.delete_event`, `reminders.list_lists`, `reminders.list`,
`reminders.create`, `reminders.complete`, `reminders.delete`.

The helper requests Calendar/Reminders access lazily on the first data
operation; `ping` and startup never trigger a TCC prompt. The binary refuses
to run with any argv other than the fixed `--json-stdin` contract.

## contacts-helper

Same protocol and build flow. Ops: `ping`, `contacts.search`, `contacts.get`,
`contacts.create`. The contact note field is deliberately not supported (it
requires the `com.apple.developer.contacts.notes` entitlement).

## notes-jxa (scripting backend)

Notes has no public framework, so it is driven by a **fixed JXA template**
(`notes-jxa/notes.js`) executed as `osascript -l JavaScript notes.js` with the
request JSON on stdin (single-shot, same wire format). The template is a
constant scanned by the CI injection guard; untrusted data only ever appears
as parsed JSON values and JXA property values. Note bodies are entity-escaped
inside the template before being handed to Notes (which stores HTML).

Ops: `ping` (no Apple Events — CI-safe), `notes.list_folders`, `notes.list`,
`notes.search`, `notes.get`, `notes.create`.

**TCC caveat:** Apple Events sent by osascript are attributed to the process
tree that runs the MCP server, so the Automation prompt names your terminal or
Claude app — not a helper binary. A compiled applet wrapper (own TCC subject,
like the Swift helpers) is planned for M5 polish.

## mail-jxa / messages-jxa (high-risk scripting backends)

Same fixed-template contract as notes-jxa. `mail.js` does unread/search/send;
`messages-send.js` sends exactly one iMessage per invocation. Both sends are
gated by elicitation confirmation in the server before the template runs, and
neither module is exposed over the remote transport.

## messages reads (FDA-isolated sqlite child)

Reading iMessage history needs Full Disk Access to `~/Library/Messages/chat.db`.
That access is confined to a **separate child process**
(`src/native/messages-helper-child`, spawned under the same Node binary) which
opens the database **read-only** and queries it with parameterized
better-sqlite3 statements — the main server process never opens the file. The
child opens the DB lazily (spawning it touches nothing until the first query)
and reports a Full-Disk-Access hint if the open fails. Point `APPLE_MCP_CHATDB`
at a fixture database to exercise it without real data.
