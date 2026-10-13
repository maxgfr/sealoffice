# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub security advisories:
https://github.com/maxgfr/sealoffice/security/advisories/new

Do not open a public issue for a security problem. Include the affected
commit or deployment (the `commit` field of `build-info.json`), steps to
reproduce, and the impact you expect. You should get a first answer within
7 days.

## Scope

In scope: the vault format and key handling, the seal-crypto wasm module, the
page and service worker code (including `live.html` and live sessions), the
recovery key, passkey and share-link key handling, the Content Security Policy, and the build and
deployment pipeline.

Bugs in the document editor itself (vendor/ibis-office) that are not specific
to sealoffice should also be reported to https://github.com/ibisjp/ibis-office.

Out of scope: what live-session relays and peers can observe by design
(session membership, IP addresses), as described in the README's security
model.
