# apple-suite-mcp

> Secure, modular, **opt-in** MCP connector for the Apple app suite — Calendar,
> Reminders, Contacts, Notes, Mail, Messages, Maps, Photos, Music, Shortcuts.
>
> A security-focused fork and rewrite of
> [supermemoryai/apple-mcp](https://github.com/supermemoryai/apple-mcp) (MIT).

**Status: 1.0.0** — all ten modules implemented, everything disabled by
default. See [`DESIGN.md`](./DESIGN.md) for the architecture and
[`CLAUDE.md`](./CLAUDE.md) for development guidance.

## Modules

| Module | Backend | macOS permission | Writes |
|---|---|---|---|
| Calendar | Swift · EventKit | Calendars | create / update / delete (delete confirmed) |
| Reminders | Swift · EventKit | Reminders | create / complete / delete (delete confirmed) |
| Contacts | Swift · Contacts.framework | Contacts | create |
| Notes | fixed JXA template | Automation | create |
| Mail | fixed JXA template | Automation | **send (always confirmed)** |
| Messages | sqlite child (reads) + JXA (send) | **Full Disk Access** | **send (always confirmed)** |
| Maps | Swift · MapKit | none | — |
| Photos | Swift · PhotosKit | Photos | — (metadata only) |
| Music | fixed JXA template | Automation | playback controls |
| Shortcuts | `shortcuts` CLI (`execFile`, no shell) | per shortcut | **run (always confirmed)** |

Mail, Messages, and Shortcuts are never exposed over the remote transport.

## Why another Apple MCP?

The popular upstream is convenient but risky: it interpolates untrusted strings
into AppleScript (injection → RCE), grabs broad permissions at once, auto-updates
from `@latest`, and has no confirmation gates. This project keeps the same
feature surface with a much smaller attack surface:

| | upstream | this project |
|---|---|---|
| Backend | AppleScript string concat | structured native helper (no script text) |
| Permissions | all at once | **disabled by default**, opt-in per module |
| Full Disk Access | required together | isolated to the Messages read child process |
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

## Install

> Do **not** use `@latest` or `--no-cache`. Pin a version.

```bash
git clone https://github.com/HanlunWang/apple-suite-mcp.git
cd apple-suite-mcp
npm ci
npm run build          # compiles TypeScript + builds and signs the Swift helpers
```

Then point your MCP client at the built server (absolute path, no auto-update):

```jsonc
{
  "mcpServers": {
    "apple-suite": {
      "command": "node",
      "args": ["/absolute/path/to/apple-suite-mcp/dist/src/server.js"]
    }
  }
}
```

Nothing is exposed until you enable a module — see below. Building the Swift
helpers requires the Xcode command line tools; the JXA-backed modules (notes,
mail, messages send, music) need no build step.

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

The model can *queue* an enable request via the `capabilities_request_enable`
tool, but it only becomes real when you approve it:

```bash
apple-mcp pending            # see what the model asked for
apple-mcp approve calendar   # apply it (FDA modules re-prompt for acknowledgement)
apple-mcp reject calendar    # or discard it
```

## Remote access (optional)

The default transport is stdio (no network exposure). To serve Claude over
HTTP, switch `transport` in the config to Streamable HTTP:

```jsonc
// ~/.apple-mcp/config.json
"transport": {
  "type": "http",
  "auth": "oauth2.1",              // or "apikey" (key auto-generated, 0600)
  "bind": "127.0.0.1",             // expose further only behind your own TLS proxy
  "port": 8765,
  "allowRemoteWrite": false,        // remote sessions are read-only by default
  "oauth": {
    "issuer": "https://your-authorization-server.example",
    "audience": "https://your-host.example/mcp"   // tokens for anything else are rejected
  }
}
```

Remote sessions always get a reduced surface: Mail and Messages are **never**
registered over HTTP, write tools require `allowRemoteWrite: true`, and every
request must carry a bearer token (JWT verified against the authorization
server's JWKS with strict issuer + audience checks, per RFC 8414/9728).

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
