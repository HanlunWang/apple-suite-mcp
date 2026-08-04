# CLAUDE.md — Development guide for Claude Code

This repository is an **Apple suite MCP connector**, built from scratch. The
authoritative design is [`DESIGN.md`](./DESIGN.md) — **read it before writing
code**.

## Your task

Implement this MCP server following the roadmap in `DESIGN.md` §8 (M0→M5).
**M0 (foundation) and M1 (security core: eventkit-helper +
calendar/reminders) are complete**; the current milestone is **M2
(permission system: per-domain TCC packaging, `manage_capabilities`,
remote Streamable HTTP + OAuth 2.1 restrictions)**.

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

M2 scope: per-domain TCC packaging, optional `manage_capabilities` meta tool,
remote Streamable HTTP transport with OAuth 2.1 (audience validation,
`allowRemoteWrite` gating).

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
