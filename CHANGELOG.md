# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/) for the npm package (independent of
the MCP spec's date-based protocol versioning).

## [Unreleased]
### Added
- M4 high-risk modules — Mail and Messages:
  - Mail via a fixed JXA template (unread/search read; send write). `mail_send`
    is in the default requireConfirmation list — the elicitation gate (with a
    recipients + subject + body-excerpt preview) fires before the template runs.
  - Messages split by risk: reads run in an **FDA-isolated child process**
    (`messages-helper-child`) that opens `chat.db` READ-ONLY and queries it
    with parameterized better-sqlite3 statements (LIKE wildcards escaped;
    attributedBody typedstream text extraction) — the main server process
    never touches the file. Sending uses a fixed JXA template and is
    confirmation-gated.
  - Both modules stay in REMOTE_BLOCKED_MODULES (never registered over HTTP);
    messages keeps the CLI Full-Disk-Access acknowledgement and lazy open
    (spawning the child touches nothing until the first query).
  - New SQL injection regression suite runs hostile payloads (DROP TABLE, LIKE
    wildcards, OR-injection) through the real prepared statements against an
    in-memory chat.db; serializer suite and module tests extended to prove
    sends never reach a backend without an accepted elicitation.
  - `better-sqlite3` pinned; CI smoke-tests the mail/messages JXA templates
    and the sqlite child.
- M3 expansion — Contacts and Notes modules:
  - `contacts-helper` (Swift, Contacts.framework): separate binary = its own
    revocable TCC subject; search/get/create over the same NDJSON protocol;
    the contact note field is deliberately untouched (needs an entitlement).
  - Notes via a FIXED JXA template (`native/notes-jxa/notes.js`) run by
    osascript with constant argv; requests arrive as parsed JSON on stdin and
    never become script source. Body text is entity-escaped inside the
    template (presentation encoding); the transport layer carries it verbatim.
    Ops: list folders/notes, search, read body, create.
  - Generic `HelperProcessClient` shared by all native helpers; per-helper
    clients with fixed binary paths and argv.
  - `scripts/build-native.sh` builds + ad-hoc signs every helper with stable
    identifiers; the CI static injection guard now also scans the JXA source.
  - Injection suite extended to contacts/notes serializers; module tests with
    fake backends; JXA runner protocol tests against a stub interpreter plus
    a real-osascript ping (no Apple Events); opt-in read-only integration
    tests for Contacts and Notes.
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
