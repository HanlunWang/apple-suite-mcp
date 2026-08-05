# Contributing

Thanks for helping build a safer Apple MCP connector.

## Before you start
Read `DESIGN.md` (authoritative design) and `CLAUDE.md` (guardrails).

## Non-negotiables (PRs violating these are rejected)
1. No untrusted data interpolated into AppleScript / shell / SQL text.
   Use the structured native backend. The `tests/injection/` suite and the
   `npm run lint` static guard enforce this.
2. Modules disabled by default; no tool/resource registered for disabled modules.
3. Side-effect actions go through elicitation confirmation.
4. Dependencies pinned to exact versions.

## Workflow
- Open an issue first for non-trivial changes.
- Write/extend tests. The injection suite must stay green.
- `npm run lint && npm test` must pass locally.
- Update `CHANGELOG.md`.

## Developer Certificate of Origin (DCO)
All commits **must** be signed off (`git commit -s`), certifying you have the
right to submit the work under the project's MIT license
(see https://developercertificate.org/). This is enforced by CI — a pull
request whose commits lack a `Signed-off-by` trailer will fail the DCO check.

To sign off retroactively: `git rebase --signoff main`.
