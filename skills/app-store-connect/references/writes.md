# Writing

## Before any write

1. `asc_describe_endpoint` for the real body schema. Guessing field names
   produces a 400 far from the mistake that caused it.
2. `dry_run: true` when you are unsure what a call will do — it validates and
   reports the exact request without sending it.
3. Say the risk tier and whether the change is reversible **before** you ask the
   user. "This is a REVENUE write and re-issuing the old price will not move
   affected subscribers back" is the sentence that matters.

## Risk tiers

Read `asc://risk` for the current definitions rather than trusting a copy. The
tiers are `READ`, `WRITE`, `RELEASE`, `REVENUE`, `DESTRUCTIVE`, `ACCESS`,
`INFRASTRUCTURE`, and by default the server asks the user to confirm `REVENUE`,
`DESTRUCTIVE`, `INFRASTRUCTURE`, `ACCESS` and `RELEASE` before anything is sent.

Risk is a tier rather than a function of the HTTP method because the method is a
poor predictor: a `DELETE` announces itself, and a `PATCH` to a price schedule
does not.

## Confirmation

Gated writes return a token and a description of what will happen. Re-issue the
**identical** call with `confirm="<token>"` — valid five minutes, single use. Do
not paraphrase the call between the two steps; the token is bound to it.

If the server prompted the user directly, no token is needed.

If `asc_status` reports `safetyMode: no-confirm`, there is no confirmation of
any kind: writes execute on the first call. Say what you are about to change
before you change it, because nothing else will.

## When a write fails

- **`ambiguous: true` means do not retry.** Apple may already have applied it. A
  write that timed out is never resent — a duplicated POST is worse than a
  reported failure. Read the current state before trying again.
- **403** — authorised, but this key's role cannot perform that operation.
- **409 on an upload** — an earlier reservation is stranded in `AWAITING_UPLOAD`.
  Delete it, then retry.
- **`appAvailabilities` 403 `does not allow 'UPDATE'`** — expected. It is
  create-only; use `asc_availability_set`.

## What is not reversible

- A price change, for subscribers already moved.
- A submission to App Review, once it enters `IN_REVIEW`.
- A deleted asset, build relationship, or tester group membership.
- Territory removal: the app is off sale in that territory immediately, and
  restoring it is another 175 writes.
