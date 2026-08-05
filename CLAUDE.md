# CLAUDE.md — Development guide for Claude Code

This repository is an **Apple suite MCP connector**, built from scratch. The
authoritative design is [`DESIGN.md`](./DESIGN.md) — **read it before writing
code**.

## Your task

The roadmap in `DESIGN.md` §8 (M0→M5) is **complete — the project is at
1.0.0** with ten modules: calendar, reminders, contacts, notes, mail,
messages, maps, photos, music, shortcuts.

Work from here is maintenance and follow-ups, not new milestones:
- MCPB packaging (bundled local server; the sanctioned distribution form for
  OS-level MCP servers) and npm publication with provenance + SBOM.
- A compiled applet wrapper for the JXA-backed modules so Automation prompts
  name a dedicated helper instead of the host process (see `native/README.md`).
- New modules follow the same contract: `src/modules/_template/`, a serializer
  boundary with an injection-suite entry, and a loader in `MODULE_LOADERS`.

## Non-negotiable security invariants (violations are bugs)

1. **Never interpolate untrusted data into script or command-line text.**
   No `` `...${x}...` `` construction of AppleScript / shell.
   - Apps with a framework go through Swift helpers (JSON on stdin).
   - Script-only apps go through JXA; data flows via variables/argv/stdin;
     templates are fixed.
   - SQLite uses parameterized `better-sqlite3` statements; never concatenate SQL.
2. **Everything off by default.** A module not enabled in config registers no
   tool/resource and triggers no TCC prompt.
3. **Side effects must pass elicitation confirmation** (send mail/message,
   delete). No automatic chained writes.
4. **Dependencies pinned to exact versions**, lockfile committed; never
   `@latest` / `--no-cache`.
5. **Zero outbound requests** (except an explicit web-search module, off by
   default). Logs redact sensitive fields.
6. Content read from Apple apps is always treated as **untrusted data**.

## MCP spec constraints (target: 2025-11-25)

- Use `@modelcontextprotocol/sdk`. Transports: **stdio** (local) and
  **Streamable HTTP + OAuth 2.1** (remote) only — no SSE.
- Read-only data as **Resources**, actions as **Tools**, reusable workflows as
  **Prompts**.
- Tool names follow the SEP-986 canonical format; tools declare `outputSchema`
  and return structured output.
- Remote mode: the server is an OAuth Resource Server — validate token
  audience, reject tokens not issued for this server.

## Development order (important)

**Write the `tests/injection/` regression suite first and let it stay red**,
then implement until it turns green. It is the security anchor; no PR may turn
it red.

M0 exit criteria (all met):
- [x] `apple-mcp status` / `enable` / `disable` CLI works
- [x] config loading + zod validation + three-gate framework
- [x] server starts, negotiates capabilities, registers dynamically (0 modules)
- [x] injection suite exists and covers the §5.1 vectors (green with the
      serialization boundary in place)
- [x] CI green (typecheck/test/audit/static injection rule; tests run on
      `node:test`, no bun dependency)

M1 exit criteria (all met): eventkit-helper (Swift, NDJSON contract in
`native/README.md`), calendar/reminders modules implementing the `AppModule`
contract and wired into `MODULE_LOADERS`, deletion behind elicitation,
injection suite green across all serializer boundaries, CI building and
smoke-testing the helper. Real-EventKit integration tests are opt-in via
`APPLE_MCP_INTEGRATION=1` (they trigger TCC prompts and touch real data).

M2 exit criteria (all met): `capabilities_list`/`capabilities_request_enable`
meta tools with pending-queue + CLI approve/reject (FDA acknowledgement
preserved), Streamable HTTP transport (loopback default, DNS-rebinding
protection, per-session servers), OAuth 2.1 resource server with strict
issuer+audience validation plus API-key mode, remote minimal surface
(REMOTE_BLOCKED_MODULES never registered remotely; writes need
allowRemoteWrite), helper code-signed with a stable TCC identifier.

M3 exit criteria (all met): contacts-helper (Swift, Contacts.framework, own
TCC subject) with search/get/create; notes module via the fixed JXA template
(`native/notes-jxa/notes.js`, data on stdin only, template scanned by the CI
injection guard); generic HelperProcessClient; build-native.sh signs all
helpers with stable identifiers.

M4 scope: mail module (JXA fixed template: unread/search/send with
elicitation on send) and messages module (better-sqlite3 parameterized reads
of chat.db in an FDA-isolated messages-helper process + JXA send). Both stay
in REMOTE_BLOCKED_MODULES; messages keeps the CLI FDA acknowledgement.

## Commands

```bash
npm install          # install (pinned) dependencies
npm run build        # compile TS (later: build Swift helpers too)
npm run dev          # run the server locally (stdio)
npm test             # all tests
npm run test:injection  # security bottom-line suite only
npm run lint         # static injection guard
```

## Style

- TypeScript `strict`. Zod schemas for all tool inputs/outputs.
- One module per app, implementing the `src/modules/_template/` contract.
- Structured error codes; never swallow exceptions. Missing permissions
  produce actionable guidance.

## Open-source compliance

- Keep the upstream attribution for `supermemoryai/apple-mcp` (MIT) in
  `NOTICE` / `LICENSE`.
- Record changes in `CHANGELOG.md`. Security issues follow `SECURITY.md`.
