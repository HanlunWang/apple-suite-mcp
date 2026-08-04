# Security Policy

This project has direct access to a user's personal Apple data (calendar,
contacts, messages, mail, etc.) and executes on their machine. We take
vulnerabilities seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Use GitHub's private
"Report a vulnerability" (Security Advisories) on this repository, or email the
maintainers listed in `package.json`. We aim to acknowledge within 72 hours.

Please include: affected version/commit, reproduction steps, and impact.

## Scope of particular concern

- **Injection**: any path where user/model-supplied text reaches AppleScript,
  `osascript`, shell, or SQL as executable text. This is the highest-severity
  class for this project (see `DESIGN.md` §5.1). Regression-tested in
  `tests/injection/`.
- **Permission bypass**: any way to invoke a module/tool that is disabled in
  config, or to perform a write in a read-only module.
- **Confirmation bypass**: performing a `requireConfirmation` action without the
  elicitation round-trip.
- **Supply chain**: tampering with published artifacts, dependency confusion.

## Supported versions

Only the latest released minor version receives security fixes.

## Disclosure

We follow coordinated disclosure. Fixes are released before public details.
