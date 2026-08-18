# app-store-connect-mcp

An MCP server for **both** of Apple's commerce APIs — App Store Connect (1,263 operations) and the App Store Server API / StoreKit 2 (30 operations) — behind four tools, with the private key in the macOS Keychain and consequential writes gated behind an explicit confirmation.

```
1,293 operations · 4 tools · key never on disk · verified against the live APIs
```

## Why it is built this way

There are several App Store Connect MCP servers. Each solves part of the problem; this one takes the part each got right and drops what they got wrong.

| | Approach | Kept | Rejected |
|---|---|---|---|
| Hand-wrapped tools | One MCP tool per endpoint | Typed, discoverable arguments | 70–900 tool definitions, >100k tokens, stale the moment Apple ships a version |
| Code Mode | LLM writes JS, server `eval`s it | Two tools, ~1k tokens, full coverage | Executes generated code in a process holding a signing key |
| Meta-tools | `search` → `call` with parameters | Same context win, **no code execution** | — |

This server uses the third. Coverage is a property of Apple's spec, not of how many endpoints someone wrapped; and the model never gets to run code inside a process that can change your pricing.

### On the sandbox

Code Mode's premise is that generated JavaScript runs safely inside Node's `vm`. It does not. Node's own documentation says `vm` is not a security mechanism, and any host object injected as a global hands back the host realm through its own prototype chain:

```js
spec.constructor.constructor('return process.env.HOME')()   // → /Users/you
```

Verified against a faithful reproduction of that sandbox: it returns the host environment. The `timeout` option does not help either — it only bounds *synchronous* execution, so an `async` busy-loop runs forever and starves the event loop.

Parameterised dispatch gets the same coverage and the same token cost with no interpreter to escape.

## Credentials

The private key belongs in the Keychain. Apple lets you download a `.p8` exactly once, and a plaintext copy on disk is a copy that can leak.

```bash
ASC_KEY=keychain:my-asc-key          # recommended
ASC_KEY=/path/to/AuthKey.p8          # works, but plaintext
ASC_PRIVATE_KEY='-----BEGIN…'        # discouraged: `ps -E` exposes it
```

A Keychain item may hold a bare PEM, or base64 JSON:

```json
{ "issuerID": "…", "keyID": "…", "privateKeyPEM": "-----BEGIN PRIVATE KEY-----\n…" }
```

The envelope form is worth preferring: the identifiers travel with the key material, so `ASC_KEY_ID` cannot drift out of sync with the key it names — a mismatch that surfaces only as an opaque 401.

```bash
security add-generic-password -s my-asc-key -a api -w "$(
  jq -nc --arg i "$ISSUER" --arg k "$KEYID" --arg p "$(cat AuthKey.p8)" \
    '{issuerID:$i,keyID:$k,privateKeyPEM:$p}' | base64
)"
```

## Install

```bash
git clone https://github.com/abd3lraouf-studios/app-store-connect-mcp
cd app-store-connect-mcp
npm install && npm run build
```

```json
{
  "mcpServers": {
    "app-store-connect": {
      "command": "node",
      "args": ["/path/to/app-store-connect-mcp/dist/index.js"],
      "env": {
        "ASC_KEY": "keychain:my-asc-key",
        "ASC_BUNDLE_ID": "com.example.app"
      }
    }
  }
}
```

`ASC_BUNDLE_ID` is required only for App Store Server API calls — Apple rejects a Server API token without a `bid` claim.

## Tools

| Tool | Purpose |
|---|---|
| `asc_status` | Verify credentials and report reachability. Run first when anything fails — it separates a bad key from a bad request. |
| `asc_search_endpoints` | Search both APIs by keyword, method, tag or risk tier. Returns operationIds. |
| `asc_describe_endpoint` | Parameters, request-body schema with real field names, risk tier. |
| `asc_call` | Execute. Handles path/query parameters, JSON bodies, pagination, and both APIs. |

## Write safety

An HTTP method is a poor proxy for consequence: `PATCH /v1/subscriptionPrices` and `PATCH /v1/appInfos/{id}` are both writes, but only one changes what customers are charged, and neither is undone by repeating it. Operations carry a risk tier:

| Tier | Count | Meaning |
|---|---|---|
| `READ` | 797 | No change. |
| `WRITE` | 238 | Changes data. |
| `REVENUE` | 61 | Pricing, subscriptions, entitlements. |
| `DESTRUCTIVE` | 132 | Deletes. |
| `RELEASE` | 12 | Builds, submissions, what ships. |
| `ACCESS` | 12 | Who can reach the account. |
| `INFRASTRUCTURE` | 11 | Certificates, identifiers, callback URLs. |

By default the bottom five tiers return a confirmation token instead of executing. The token is bound by hash to the exact operation, path, query and body, so it cannot be obtained for a cheap call and spent on an expensive one. It is single-use and expires in five minutes.

```
--read-only    block every write        --confirm     confirm every write
--no-confirm   never confirm            (default)     confirm the five tiers above
```

## Transports

```bash
node dist/index.js                       # stdio (default)
node dist/index.js --transport http --http-token "$(openssl rand -hex 32)"
```

HTTP binds to `127.0.0.1` and **refuses to start without a bearer token**. This process holds a key that can change App Store pricing; it should not listen unauthenticated. Binding off-loopback warns and is best paired with a TLS-terminating proxy or an SSH tunnel.

## Keeping up with Apple

```bash
npm run fetch:specs   # re-download both descriptions
npm run build         # recompile the operation index
npm run verify        # drift check + live calls against both APIs
```

The two APIs are sourced differently, of necessity:

- **App Store Connect** — Apple publishes a real OpenAPI 3.0 document. It is downloaded and compiled into a slim index (360KB, against a 3.3MB spec) so search stays fast and the full document is opened only to describe one operation.
- **App Store Server** — Apple publishes **no** OpenAPI document; the documentation is prose. The authoritative machine-readable description is Apple's own client, [`apple/app-store-server-library-node`](https://github.com/apple/app-store-server-library-node), where every endpoint is a literal `makeRequest` call. `fetch:specs` parses the endpoint set out of that source at a pinned release tag, and `verify` diffs it against the catalogue in `src/storekit.ts`.

Two details in that catalogue contradict what the documentation implies, and both are load-bearing:

- The hosts are `api.storekit.apple.com` / `api.storekit-sandbox.apple.com`. The older `api.storekit.itunes.apple.com` names no longer serve this API.
- The mass renewal-extension status path orders its segments `{productId}/{requestIdentifier}` — not the reverse.

## Verification

`npm run verify` is read-only and makes real calls. Last run:

```
1. Catalogue drift — src/storekit.ts vs Apple’s client
  ✓ all 30 Apple endpoints present in the catalogue
  ✓ no endpoints in the catalogue that Apple does not define

2. App Store Connect API — live
  ✓ apps_getCollection → 2 apps
  ✓ apps_getInstance / builds / appStoreVersions → HTTP 200
  ✓ pagination walked 3 pages
  ✓ bogus id → structured 404

3. App Store Server API (StoreKit 2) — live
  ✓ storekit token carries bid;  connect token correctly omits it
  ✓ getTransactionInfo / getAllSubscriptionStatuses / getTransactionHistory v2
      → authenticated and routed (Apple errorCode 4000006)
  ✓ getNotificationHistory (30d window) → HTTP 200

14 passed, 0 failed
```

StoreKit probes use a deliberately invalid transaction ID. The signal is the *shape* of the reply: a structured Apple `errorCode` proves the request was authenticated and routed, where a `401` would prove it was not.

## Known limits

- **JWS responses are decoded, not verified.** StoreKit payloads arrive signed by Apple; verifying the chain needs Apple's root certificates. Decoded values appear in `*_decoded` fields and are labelled unverified. Do not treat them as proof of purchase without checking the signature.
- **Risk tiers are pattern-matched** from method and path. They are deliberately cautious, but read `asc_describe_endpoint` before a write rather than trusting the tier alone.
- **Keychain storage is macOS-only.** Elsewhere, use a file path with restrictive permissions.
- `--no-confirm` disables the gate entirely. It exists for CI; it is a poor default for an interactive agent.

## Licence

[Business Source License 1.1](LICENSE). Free for internal use, evaluation and
development; offering it to third parties as a hosted or embedded service, or
redistributing it inside a commercial product, needs a licence. Converts to
Apache-2.0 on 2030-08-19.

Apple's OpenAPI description and root certificate are vendored here under
Apple's terms, not this licence — see [NOTICE](NOTICE).
