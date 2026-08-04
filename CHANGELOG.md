# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/) for the npm package (independent of
the MCP spec's date-based protocol versioning).

## [Unreleased]
### Added
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
