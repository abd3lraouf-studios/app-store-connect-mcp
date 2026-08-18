# Test certificate chain

A throwaway three-certificate chain used to exercise the *accept* path of
signature verification without a real Apple-signed payload.

It carries the two OIDs Apple's verifier insists on —
`1.2.840.113635.100.6.2.1` on the intermediate and `1.2.840.113635.100.6.11.1`
on the leaf — because a chain without them is rejected before the signature is
even checked, which would make the test prove nothing.

Regenerate with `bash scripts/make-test-chain.sh test/fixtures`. These keys are public and
guard nothing.
