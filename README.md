# apple-suite-mcp

> Secure, modular, **opt-in** MCP connector for the Apple app suite — Calendar,
> Reminders, Contacts, Notes, Mail, Messages, Maps, Photos, Music.
>
> A security-focused fork and rewrite of
> [supermemoryai/apple-mcp](https://github.com/supermemoryai/apple-mcp) (MIT).

**Status:** M1 (security core) complete — **Calendar and Reminders work
end-to-end** through a native Swift EventKit helper (structured JSON on stdin,
no script text anywhere on the data path), on top of the M0 foundation:
capability config, three-gate framework, dynamic registration, CLI,
elicitation confirmation, and the injection regression suite. Next: M2
(permission system polish, remote OAuth 2.1). See [`DESIGN.md`](./DESIGN.md)
for the full architecture and [`CLAUDE.md`](./CLAUDE.md) for build guidance.

## Why another Apple MCP?

The popular upstream is convenient but risky: it interpolates untrusted strings
into AppleScript (injection → RCE), grabs broad permissions at once, auto-updates
from `@latest`, and has no confirmation gates. This project keeps the same
feature surface with a much smaller attack surface:

| | upstream | this project |
|---|---|---|
| Backend | AppleScript string concat | structured native helper (no script text) |
| Permissions | all at once | **disabled by default**, opt-in per module |
| Full Disk Access | required together | isolated to the Messages helper only |
| Updates | `@latest` auto | pinned versions + provenance + SBOM |
| Side-effects | none | elicitation confirmation |
| MCP spec | — | 2025-11-25 (Streamable HTTP + OAuth 2.1) |

## Design highlights

- **Capability model.** A module that isn't enabled contributes zero tools/
  resources and never triggers a macOS permission prompt.
- **Activate what you use.** `apple-mcp enable calendar` / `enable reminders --write`.
  Changes apply on restart (deliberately, to prevent runtime coercion).
- **No injection by construction.** Untrusted data is passed as structured args
  to a Swift/JXA helper, never concatenated into executable script text. Enforced
  by `tests/injection/` and a CI static guard.

## Install (once released)

> Do **not** use `@latest` or `--no-cache`. Pin a version.

```jsonc
{
  "mcpServers": {
    "apple-suite": {
      "command": "npx",
      "args": ["apple-suite-mcp@0.1.0"]   // pin the version
    }
  }
}
```

## Capability control

```bash
apple-mcp status                 # module matrix + config path
apple-mcp enable calendar        # read-only
apple-mcp enable reminders --write
apple-mcp enable messages --yes  # FDA module: requires explicit acknowledgement
apple-mcp disable mail
```

Changes apply on server **restart** (deliberate — a running session cannot be
coerced into enabling capabilities). Config lives at `~/.apple-mcp/config.json`,
created locked-down (everything disabled) on first run.

## Develop

Requires Node ≥ 22.6 to run TS directly (CI uses 24); the built `dist/` runs on ≥ 20.

```bash
npm ci
npm run build          # compile TS + build the Swift eventkit-helper
npm run lint           # static injection guard
npm test               # node:test — includes the injection regression suite
npm run dev            # stdio server
```

Integration tests against the real EventKit stores (they trigger a macOS
permission prompt and touch your default calendar/reminder list) are opt-in:

```bash
APPLE_MCP_INTEGRATION=1 npm test
```

## Security

See [`SECURITY.md`](./SECURITY.md). Report vulnerabilities privately.

## License

MIT. Retains upstream attribution — see [`NOTICE`](./NOTICE).
