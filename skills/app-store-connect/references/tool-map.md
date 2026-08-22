# Which tool

Five core tools cover everything; eight composites exist only for chains the raw
API cannot express in one call. A tool that merely saved one request was
deliberately left out.

## Core

| Tool | Use it for |
|---|---|
| `asc_status` | Credentials, reachability, remaining rate-limit budget. **First thing to run when anything fails.** |
| `asc_search_endpoints` | Find an operation by keyword, method, tag or risk tier. |
| `asc_describe_endpoint` | Its parameters, request-body schema with real field names, risk tier. |
| `asc_call` | Reads. Path and query parameters, `paginate`, `max_pages`. |
| `asc_write` | Everything that changes data. `dry_run`, confirmation, risk tiers. |

## Composite — reach for these before hand-rolling

| Tool | The chain it replaces | Why not by hand |
|---|---|---|
| `asc_pricing_get` | ~175 lookups → a handful | Covers subscriptions **and** one-time purchases; the currency lives on the territory, so reading prices by hand gives ambiguous numbers. |
| `asc_pricing_set` | The same chain plus the write | Forces the subscriber decision into the open. |
| `asc_preflight_version` | Six resources → GO / NO-GO | Each gap names the operation that fixes it. |
| `asc_listing_screenshots` | A request per locale → four | Uses `included`. |
| `asc_upload_screenshot` | Reserve → PUT at offsets → commit with MD5 | Two hosts, and a checksum that fails *silently*. |
| `asc_upload_iap_screenshot` | The same for an IAP review screenshot | The field that keeps an IAP in `MISSING_METADATA`. |
| `asc_availability_set` | One PATCH per territory, up to 175 | Apple has no bulk endpoint, and it **re-reads every territory** and reports what did not take. |
| `asc_analytics_report` | Five hops → signed URL → gunzip → rows | Stitches **every** segment. |

## Resources, not recall

`asc://enums` — every enum value, generated from Apple's spec.
`asc://risk` — what each risk tier means.
`asc://cookbook` — the 14 traps in full.
`asc://sources` — which spec version this server was built from, and when.

## Prompts

Four whole-questions are already assembled; prefer them to building the chain:
`/mcp__asc__release-readiness`, `/mcp__asc__pricing-audit`,
`/mcp__asc__review-triage`, `/mcp__asc__testflight-status`.
