# Security

This server holds an App Store Connect API key — a credential that can change
what your customers are charged. That shapes every decision below.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/abd3lraouf-studios/app-store-connect-mcp/security/advisories/new).
Please do not open a public issue for anything exploitable.

## What the design assumes

**Your key is not ours to hold loosely.** The recommended configuration keeps
it in the macOS Keychain and reads it at point of use. Apple lets you download
a `.p8` exactly once, so a plaintext copy on disk is a copy that can leak.
Passing the key inline via `ASC_PRIVATE_KEY` is supported and discouraged:
`ps -E` shows the environment of your own processes to any process running as
you.

**Only Apple's hosts ever see a bearer token.** Every URL is checked against an
allowlist of three exact hostnames, including the `links.next` pagination
cursor — a server-supplied URL that would otherwise walk a live token wherever
it pointed. The allowlist is exact hostnames rather than IP filtering, because
octal, hex and IPv4-mapped-IPv6 encodings defeat hand-rolled address checks.

**Writes are gated, and the gate is not advisory.** `asc_write` carries
`_meta["anthropic/requiresUserInteraction"]`, which Claude Code honours even
under `bypassPermissions`. Where a client supports elicitation, the person is
asked directly; otherwise a confirmation token is issued, bound by hash to the
exact operation, path, query and body, so one obtained for a cheap call cannot
be spent on an expensive one.

**Apple's signatures are verified, not just decoded.** App Store Server API
payloads are checked against Apple Root CA - G3, vendored in `certs/` so
verification cannot be switched off by a network failure. Where verification
cannot run, every field says so rather than staying silent.

**Data from strangers is labelled.** Customer review text arrives in your
model's context verbatim. Results carrying it lead with a note saying it is
data to report on, not instructions to follow. It is deliberately not filtered
for injection phrases: that is a game attackers iterate against, and passing
such a filter would imply a safety it cannot deliver.

**The HTTP transport is closed by default.** It refuses to start without a
bearer token, binds to loopback, and validates `Host` and `Origin` to stop DNS
rebinding — a browser page can otherwise reach a loopback-bound server as
same-origin, where a token alone is no defence.

## Known limits

- Risk tiers are pattern-matched from method and path. They are deliberately
  cautious, but they are heuristics.
- `--no-confirm` disables the gate. It exists for CI and is a poor default
  anywhere a person is present.
- `--no-online-checks` skips OCSP, which means accepting a revoked certificate.
- Keychain storage is macOS-only.
