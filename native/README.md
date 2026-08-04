# Native helpers

Each sensitive domain is a **separate compiled executable** so it becomes its
own TCC-responsible process (DESIGN.md §2, §3.5). This lets macOS show and
revoke each permission independently, and confines Full Disk Access to Messages.

Status:
- `eventkit-helper/`  — Swift, EventKit (Calendar + Reminders)    ✅ M1
- `contacts-helper/`  — Swift, Contacts.framework                 planned (M3)
- `messages-helper/`  — chat.db (needs FDA, isolated)             planned (M4)

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
