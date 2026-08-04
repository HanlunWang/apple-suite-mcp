# Native helpers

Each sensitive domain is a **separate compiled executable** so it becomes its
own TCC-responsible process (DESIGN.md §2, §3.5). This lets macOS show and
revoke each permission independently, and confines Full Disk Access to Messages.

Planned:
- `eventkit-helper/`  — Swift, EventKit (Calendar + Reminders)   [M1]
- `contacts-helper/`  — Swift, Contacts.framework                [M3]
- `messages-helper/`  — Swift/Node, chat.db (needs FDA, isolated) [M4]

**Contract:** helpers read a JSON request on stdin and write a JSON response on
stdout. Untrusted fields are used as typed API arguments — never concatenated
into AppleScript/shell text.
