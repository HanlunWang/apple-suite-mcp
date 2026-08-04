# Apple Suite MCP Connector — Architecture & Implementation Plan (v2)

> A secure, modular, opt-in MCP server for the Apple app suite.
> Forked from `supermemoryai/apple-mcp` (MIT); core rewritten, with a real
> permission model and security boundaries added.
> v2 targets MCP spec **2025-11-25** and stays compatible with the
> **2026-07-28** draft direction (stateless core / MCP Apps / Tasks).

---

## 0. Goals and non-goals

**Goals**
- Cover the native Apple app suite (Calendar / Reminders / Contacts / Notes /
  Mail / Messages / Maps / Photos / Music …) through a single connector for Claude.
- Zero permissions and zero exposure by default; capabilities are activated
  one by one, only when needed.
- Eliminate the code-injection vulnerability class, shrink the attack surface,
  and gate side-effecting operations behind confirmation.
- Full compliance with the official MCP specification and security best
  practices; production-grade code quality and performance.

**Non-goals**
- We do not optimize for "install once, get every permission" convenience.
- We do not expose high-risk write operations by default in remote mode.

---

## 1. Threat model (aligned with the OWASP MCP Top 10)

| Threat | OWASP MCP category | State of the upstream repo | Countermeasure here |
|---|---|---|---|
| **AppleScript / shell injection** | Injection / tool-parameter abuse | Only `"` is escaped, `\` is not — bypassable → arbitrary command execution | §5.1 structured native backend; data never enters a code path (official best practice: never build shell commands from tool parameters) |
| **Prompt injection** | Prompt Injection | No defenses; the selling point is literally "read mail → act automatically" | §5.4 content read from apps is marked untrusted + side effects force elicitation + no automatic chained writes |
| **Tool poisoning / rug-pull** | Tool Poisoning | Tool descriptions can be silently changed later | §5.2 pinned versions + signed releases + tool definitions under version control and verification |
| **Supply-chain poisoning** | Supply Chain | `@latest` + `--no-cache` pulls and executes the newest version on every start | §5.2 exact pins + lockfile + provenance + SBOM + minimal dependencies |
| **Confused deputy / token passthrough** | Confused Deputy | No concept of auth | §4 OAuth 2.1 Resource Server; reject tokens not issued for this server; audience validation |
| **Session hijacking** | Session Mgmt | None | §4 cryptographically secure session ids; prefer stateless requests (2026-07-28 direction) |
| **Excessive permission grants** | Excessive Permissions | The whole suite gets FDA etc. at once | §3 capability model — everything off by default, authorized per module |
| **Accidental deletion / sending** | — | Zero confirmation gates | §5.5 elicitation confirmation protocol |

---

## 2. Layered architecture

```
┌─────────────────────────────────────────────────────────┐
│  MCP Client (Claude Desktop / Web / iOS)                 │
└───────────────┬─────────────────────────────────────────┘
                │  stdio (local) │ Streamable HTTP + OAuth 2.1 (remote)
┌───────────────▼─────────────────────────────────────────┐
│  Layer 1  MCP Server (TypeScript, @modelcontextprotocol/sdk) │
│   • capability negotiation (tools/resources/prompts + listChanged) │
│   • dynamic registration (only enabled modules registered) │
│   • zod input validation + outputSchema structured output │
│   • elicitation confirmation gate / permission orchestration │
│   • multi-layer rate limiting / structured logs / redaction │
└───────────────┬─────────────────────────────────────────┘
                │  structured JSON over stdin/stdout (never shell strings)
┌───────────────▼─────────────────────────────────────────┐
│  Layer 2  Native helpers (one executable per sensitive domain = its own TCC subject) │
│   • eventkit-helper (Swift)  Calendar + Reminders        │
│   • contacts-helper (Swift)  Contacts.framework          │
│   • messages-helper (separate process, needs FDA, revocable on its own) │
│   • scripting-helper (JXA)   apps without a Framework    │
└───────────────┬─────────────────────────────────────────┘
                │  Apple frameworks / EventKit / Contacts / SQLite
┌───────────────▼─────────────────────────────────────────┐
│  Layer 3  macOS TCC (system-level authorization, per capability) │
└─────────────────────────────────────────────────────────┘
```

**Key points**
- Layer 1 ↔ Layer 2 exchange **structured JSON only** (stdin/argv). Shell
  commands or AppleScript source are never concatenated.
- Each sensitive domain is a **separate executable → its own TCC subject**
  (the "disclaim shim" idea): revocable individually in System Settings,
  with no coupling between domains.

---

## 3. Capability model

### 3.1 Three gates

```
① Is the module enabled?    → config.enabledModules; if not enabled, its tools/resources are never registered
② Does the mode match?      → read / write; write operations require the module to declare write explicitly
③ Does the action need confirmation? → irreversible/outbound actions go through elicitation (§5.5)
```

### 3.2 Primitive mapping (idiomatic MCP)

| MCP primitive | Used for | Example |
|---|---|---|
| **Resource** (read-only) | reading app data | `calendar://events?range=...`, `contacts://search?q=...` |
| **Tool** (action) | writes / side effects | `calendar_create_event`, `mail_send` |
| **Prompt** (template) | reusable workflows | `daily_planner`, `weekly_review` |

Read-only capabilities are preferentially modeled as Resources — inherently
read-only, semantically clear, cacheable by clients.

### 3.3 Config-driven, everything off by default

`~/.apple-mcp/config.json` (generated on first run, everything empty/read):

```jsonc
{
  "version": 1,
  "protocol": "2025-11-25",
  "modules": {
    "calendar":  { "enabled": false, "mode": "read" },
    "reminders": { "enabled": false, "mode": "read" },
    "contacts":  { "enabled": false, "mode": "read" },
    "notes":     { "enabled": false, "mode": "read" },
    "mail":      { "enabled": false, "mode": "read" },
    "messages":  { "enabled": false, "mode": "read" },  // needs FDA, isolated process
    "maps":      { "enabled": false, "mode": "read" },
    "photos":    { "enabled": false, "mode": "read" },
    "music":     { "enabled": false, "mode": "read" }
  },
  "requireConfirmation": ["mail.send", "messages.send", "*.delete"],
  "transport": { "type": "stdio" },   // or { "type": "http", "auth": "oauth2.1" }
  "rateLimits": { "perToolPerMinute": 30, "perSessionPerMinute": 120 }
}
```

**Why registration-time gating instead of runtime checks**
> A disabled module exposes no tool/resource to the client at all. Claude's
> tool list simply does not contain `mail_send`, so there is nothing to call.
> This is an order of magnitude safer than "the tool exists but refuses at
> runtime" — the model never gets the chance to try, and the surface usable
> by prompt injection shrinks accordingly.

### 3.4 Activation (install ≠ get everything; enable what you use)

1. **CLI (recommended, human in the loop)**
   ```bash
   apple-mcp enable calendar            # read-only
   apple-mcp enable reminders --write   # read/write
   apple-mcp enable messages --write    # prompts for separate FDA grant
   apple-mcp disable mail
   apple-mcp status
   ```
   Config changes require a **server restart** to take effect — deliberately,
   to prevent a running session from being coaxed into hot-enabling modules.

2. **A single resident meta tool `manage_capabilities` (optional)**
   - `list_capabilities` → read-only view of the current matrix
   - `request_enable(module, mode)` → **only writes a pending record, does not
     take effect**; requires second confirmation via CLI/system dialog
   If this tool is kept and runtime changes are allowed, the server must
   declare the `tools.listChanged` capability and emit
   `notifications/tools/list_changed`. The default is "apply on restart" to
   avoid that dynamic surface entirely.

3. **TCC is naturally lazy**: even with a module enabled, macOS prompts for
   authorization only on the first real API call. "Enabled" ≠ "authorized" —
   the two layers stack.

### 3.5 Messages (FDA) special isolation

- Only `messages` touches `~/Library/Messages/chat.db`, which requires Full
  Disk Access.
- It runs in a **separate `messages-helper` process** — its own TCC subject.
- When disabled, that helper is not on the startup path and FDA is **not**
  needed at all.
- On enable, the CLI explicitly warns that the entire iMessage history becomes
  readable.

---

## 4. Transport & remote security (MCP 2025-11-25)

| Mode | Scenario | Policy |
|---|---|---|
| **stdio** (default) | Claude Desktop, local | no network exposure; safest |
| **Streamable HTTP** (optional) | Claude Web / iOS, remote | **OAuth 2.1** (the server is a Resource Server; MUST validate token audience and reject tokens not issued for this server); a single `/mcp` endpoint supporting POST+GET; bind `127.0.0.1`; external exposure requires your own reverse proxy + TLS |

**Minimal remote surface by default**: `allowRemoteWrite: false`; write mode
and the messages/mail modules are not exposed remotely unless individually
unlocked.
**OAuth endpoint validation**: strictly validate `authorization_endpoint`
(cf. CVE-2025-6514: a malicious endpoint URL led to command injection).
**Stateless first**: aligned with the 2026-07-28 direction — make requests as
self-contained as possible and minimize session dependence.

---

## 5. Security hardening

### 5.1 Eliminating injection: structured native backend (official best practice)

**Principle: untrusted data never enters code/script text.**
> The MCP security guidance is explicit: avoid servers that build shell
> commands from tool parameters; prefer language-native libraries.

- **Apps with a framework** (Calendar/Reminders → EventKit, Contacts →
  Contacts.framework, Photos → PhotosKit): Swift helpers; parameters arrive as
  JSON on stdin; objects are built through typed APIs; the concept of a
  "script string" does not exist.
- **Apps with only a scripting interface** (Notes/Mail): JXA instead of
  concatenated AppleScript source; data flows in via variables/`argv`/stdin;
  script templates are fixed.
- **Absolutely forbidden**: `` `...${userInput}...` `` style interpolation
  into AppleScript/shell. A CI static rule blocks it (§7).
- **SQLite** (Messages): `better-sqlite3` prepared, parameterized statements;
  never concatenate SQL strings.

### 5.2 Supply chain

- Dependencies pinned to **exact versions**, lockfile committed, dependency
  tree minimized.
- README installation instructions use **local absolute paths** or pinned
  versions; `@latest` / `--no-cache` are **forbidden**.
- Releases go through CI: build + SBOM (SPDX/CycloneDX) + npm `--provenance`
  + artifact signing.
- No prebuilt `.dxt`/MCPB bundle committed to git; it is a CI artifact only,
  reproducible from source.
- Dependabot/OSV scanning + `npm audit` as CI gates.
- Publisher identity is verifiable; the official `@modelcontextprotocol/`
  namespace is not squatted.

### 5.3 Privacy / zero exfiltration

- Beyond each module's own function (web-search stays off by default), zero
  outbound requests; a CI network-allowlist check enforces this.
- Structured (JSON) logs; sensitive fields (message/mail bodies, phone
  numbers, email addresses) redacted by default or never persisted.

### 5.4 Prompt-injection posture

- Anything read from an app is treated as **untrusted data**; tool results
  carry an `_untrusted: true` provenance marker.
- **No automatic chained writes**: one call never implicitly triggers another
  write. "Read mail → send message" must be two independent calls, each
  passing its own confirmation gate.
- Every side effect goes through §5.5 — the decision returns to the human.

### 5.5 Confirmation protocol (native MCP elicitation)

For actions matched by `requireConfirmation` (send mail/message, delete):
```
call mail_send(...) → server requests confirmation from the client via
   elicitation, with a preview { to, subject, body summary } → the user
   confirms in the client UI → only then does the action execute
```
Protocol-native elicitation is used instead of an invented token scheme; it is
portable across clients and the confirmation UI is rendered uniformly by the
client.
Rate limiting: multiple layers (user/session/tool/resource) against abuse.

---

## 6. Module matrix

| Module | Backend API | Permission tier | Priority | Notes |
|---|---|---|---|---|
| **Calendar** | EventKit (Swift) | calendar access | P0 | event read/write, range queries |
| **Reminders** | EventKit (Swift) | reminders access | P0 | lists/subtasks/priority/due dates |
| **Contacts** | Contacts.framework | contacts | P1 | search/read/optional write |
| **Notes** | JXA | automation | P1 | list/search/create |
| **Mail** | JXA | automation | P2 | unread/search/send (confirmed) |
| **Messages** | SQLite read + JXA send | **FDA**, isolated process | P2 | high-risk, off by default, separate grant |
| **Maps** | MapKit / URL scheme | none special | P3 | place search/directions |
| **Photos** | PhotosKit (Swift) | photo library | P3 | metadata/search |
| **Music** | ScriptingBridge / MusicKit | media | P3 | playback control/library |
| **Shortcuts** | `shortcuts` CLI | per shortcut | P4 | trigger existing shortcuts |

Every module has read/write separation and its own TCC subject.

---

## 7. Code quality & performance

### 7.1 Checklist against the forked code

- [ ] **Injection surface**: grep every `runAppleScript(\``/`exec(`/template
      interpolation into scripts; rewrite all of it per §5.1.
- [ ] **SQL construction**: Messages queries move to parameterized
      `better-sqlite3`.
- [ ] **Process overhead**: upstream spawns a `sqlite3`/`osascript` per call →
      switch to **resident helper processes + JSON-RPC reuse**.
- [ ] **Error handling**: structured error codes; missing permissions produce
      actionable guidance.
- [ ] **Type safety**: TS `strict`; zod schemas + `outputSchema` for all tool
      inputs/outputs.
- [ ] **Resource leaks**: close apps in `finally`; helper timeouts and
      graceful shutdown.
- [ ] **Concurrency**: serialize/lock calls to the same app to avoid
      AppleScript races.
- [ ] **Zero-trust logging**: no sensitive data persisted by default.

### 7.2 Performance targets

| Metric | Target |
|---|---|
| Cold start (server ready) | < 500 ms |
| Single read (helper resident), p95 | < 150 ms |
| Process reuse | helpers stay resident; never spawn per call |
| Large lists | pagination + default limit |
| Caching | short TTL for read-only metadata + invalidate on write |

### 7.3 Testing & CI

- **Unit**: helper parameter serialization, error paths.
- **Integration**: macOS runners driving real apps with a test account.
- **Injection regression suite (security bottom line)**: fixtures with
  trailing backslashes, `do shell script`, SQL metacharacters, etc.; assert
  **no code execution / rejected**. No PR may turn it red.
- **CI gates**: lint + typecheck + all tests + static rule (no script
  interpolation) + dependency audit + network allowlist.

---

## 8. Milestone roadmap

| Milestone | Content | Deliverable |
|---|---|---|
| **M0 Foundation** | fork, keep MIT/NOTICE, TS+Swift project layout, CI skeleton, config + dynamic-registration framework, **write the injection suite first** | empty shell runs; `status`/`enable` usable; injection tests red pending implementation |
| **M1 Security core** | eventkit-helper; Calendar+Reminders rewritten on the structured backend; elicitation confirmation; injection tests green | both P0 modules, security bar met |
| **M2 Permission system** | three gates, per-domain TCC packaging, `manage_capabilities`, remote OAuth 2.1 restrictions | capability model complete |
| **M3 Expansion** | Contacts / Notes (P1) | more than half the suite |
| **M4 High-risk** | Mail / Messages, FDA isolation, confirmation hard-wired | full functionality, high-risk off by default |
| **M5 Polish** | Maps/Photos/Music/Shortcuts, performance, caching, `server.json` publication, SBOM + signing | 1.0 open-source release |

---

## 9. Repository layout

```
apple-suite-mcp/
├─ src/
│  ├─ server.ts            # MCP entry, capability negotiation, dynamic registration
│  ├─ config.ts            # config load/validation, gating
│  ├─ registry.ts          # module → tool/resource registration
│  ├─ confirm.ts           # elicitation confirmation
│  ├─ logger.ts            # structured logs + redaction
│  ├─ transport/           # stdio.ts / http.ts (OAuth 2.1)
│  └─ modules/
│     ├─ _template/        # module contract (every app implements this)
│     ├─ calendar/  reminders/  contacts/  notes/ …
├─ native/                 # Swift helpers (EventKit/Contacts/Messages)
├─ cli/                    # apple-mcp enable/disable/status
├─ tests/
│  ├─ unit/  integration/  injection/   # injection = security bottom line
├─ .github/workflows/      # ci.yml / release.yml (provenance + SBOM)
├─ server.json             # MCP Registry metadata
├─ NOTICE / LICENSE        # upstream MIT attribution retained
├─ SECURITY.md CONTRIBUTING.md CODE_OF_CONDUCT.md CHANGELOG.md
├─ CLAUDE.md               # development guide for Claude Code
├─ DESIGN.md               # this document
└─ README.md               # install with pinned versions/local paths; no @latest
```

---

## 10. Open-source compliance

- Upstream is MIT; the fork **must retain the original copyright notice**
  (`NOTICE` + `LICENSE` state "based on supermemoryai/apple-mcp").
- New code remains MIT.
- Health files in place: `SECURITY.md` (vulnerability disclosure),
  `CONTRIBUTING.md` (with DCO), `CODE_OF_CONDUCT.md`, `CHANGELOG.md`
  (Keep a Changelog).
- The npm package uses **semantic versioning** (independent of MCP's
  date-based protocol versions).
- The README states the relationship to upstream and the main changes
  (security rewrite / permission model) — both an obligation and this fork's
  selling point.

---

## Appendix: the difference from the upstream repo in one line

> Upstream: install once, all permissions, string-concatenated scripts,
> `@latest` auto-update, no auth, no confirmation.
> This project: everything off by default, per-capability activation,
> structured native backend, pinned versions, OAuth 2.1, elicitation
> confirmation.
> Same feature surface, an order of magnitude smaller attack surface, fully
> compliant with MCP 2025-11-25.
