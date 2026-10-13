# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub security advisories:
https://github.com/maxgfr/sealoffice/security/advisories/new

Do not open a public issue for a security problem. Include the affected
commit or deployment (the `commit` field of `build-info.json`), steps to
reproduce, and the impact you expect. You should get a first answer within
7 days.

## Scope

In scope: the library format and key handling (protected library, per-document
locks, the crash-safe switch to a protected library), the seal-crypto wasm
module, the page and service worker code (including `live.html` and live
sessions), the recovery key, passkey and share-link key handling, encrypted
exports and backups, the Content Security Policy, and the build and
deployment pipeline.

## Threat model in brief

- **Unprotected library (default).** Readable by anyone with access to the
  browser profile: the library key is stored in the clear next to the
  encrypted documents. Reading it that way is not a vulnerability.
- **Protected library.** Documents, versions and the index must not be
  readable from a copy of the storage without the passphrase, the recovery
  key or the passkey.
- **Locked document.** Must not be readable without its own passphrase, even
  with the library key or the recovery key. There is no recovery by design.
- **Encrypted export.** An age or Office-protected download must not be
  readable without the passphrase or password chosen for it.

See the README's security model for details and known limits.

Bugs in the document editor itself (vendor/ibis-office) that are not specific
to sealoffice should also be reported to https://github.com/ibisjp/ibis-office.

Out of scope: what live-session relays and peers can observe by design
(session membership, IP addresses), as described in the README's security
model.
