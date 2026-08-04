# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/) for the npm package (independent of
the MCP spec's date-based protocol versioning).

## [Unreleased]
### Added
- M2 permission system:
  - `capabilities_list` / `capabilities_request_enable` meta tools: the model
    can inspect the module matrix and queue enable requests, which only take
    effect after `apple-mcp approve <module>` (FDA acknowledgement preserved)
    and a server restart. New CLI commands: `pending`, `approve`, `reject`.
  - Remote transport: Streamable HTTP (single `/mcp` endpoint, loopback bind
    by default, DNS-rebinding Host allowlist, cryptographically random
    session ids, per-session server instances, RFC 9728 protected-resource
    metadata, RFC 6750 `WWW-Authenticate` challenges).
  - Auth: OAuth 2.1 resource server (JWT via the authorization server's JWKS,
    strict issuer + **audience** validation — tokens minted for other services
    are rejected) or a locally generated API key (0600, constant-time compare).
  - Remote minimal surface: Mail/Messages are never registered over HTTP;
    write tools degrade to read unless `allowRemoteWrite: true`; the
    enable-request meta tool is local-only.
  - eventkit-helper is now ad-hoc code-signed with a stable identifier so TCC
    grants survive rebuilds.
- M1 security core — Calendar and Reminders modules working end-to-end:
  - `eventkit-helper` (Swift, EventKit): resident NDJSON-over-stdio process,
    its own TCC subject, lazy permission requests, structured error codes
    with actionable hints, fixed `--json-stdin` argv contract (data never in
    argv), `ping` op for TCC-free health checks.
  - Resident helper client (lazy spawn on first call, id-matched concurrent
    requests, timeouts with permission-dialog hints, automatic respawn after
    a crash); one shared process serves both modules.
  - Calendar module: list calendars/events, create/update/delete event;
    reminders module: list lists/reminders, create/complete/delete. Read and
    write tools split; deletion gated behind elicitation confirmation
    (`*.delete`); read results carry the `_untrusted` marker; described zod
    schemas with range limits on every parameter.
  - Injection suite extended across all serializer boundaries (calendar +
    reminders); module tests over an in-memory MCP connection prove the
    helper is never reached without confirmation; protocol tests run against
    a fake helper plus a TCC-free `ping` against the real binary; real
    EventKit integration tests are opt-in via `APPLE_MCP_INTEGRATION=1`.
  - CI builds the Swift helper and smoke-tests the wire protocol.
- M0 scaffold: design doc, capability config schema, module contract,
  injection regression suite, CI with injection gate, OSS health files.
- M0 implementation:
  - Config loader with first-run locked-down defaults (`~/.apple-mcp/config.json`,
    0600), zod validation, forward-compatible module merging, actionable errors.
  - Registration-time gating: disabled modules are never `import()`ed and expose
    zero tools/resources; write tools require write mode.
  - Elicitation confirmation gate for side-effecting actions (fail-closed when
    the client lacks elicitation support); resource reads labeled `_untrusted`.
  - `apple-mcp status | enable [--write] [--yes] | disable` CLI with Full Disk
    Access acknowledgement flow for the messages module.
  - Calendar backend serialization boundary: structured JSON over stdin to a
    fixed helper binary/argv — no script text on the data path.
  - Structured stderr JSON logging with sensitive-field redaction; sliding-window
    rate limiting (per-tool + per-session).
  - Injection regression suite green (payload fidelity + fixed invocation
    assertions); unit tests for config, gating, CLI, and confirmation flow over
    an in-memory MCP connection.
  - MCP best-practice hardening (per Anthropic connector guidance): server
    `instructions` documenting the capability model and the `_untrusted` data
    contract; every tool always carries `title` + `readOnlyHint` +
    `destructiveHint` annotations (write tools default to destructive);
    cancellation `AbortSignal` passed through to module `run()` handlers.
### Changed
- Tests run on the Node built-in test runner (`node:test`) instead of bun —
  zero extra dev dependencies; CI uses Node 24.
- Dropped `better-sqlite3` from dependencies until M4 (messages) needs it.
