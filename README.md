# sealoffice

An office suite for Word, Excel and PowerPoint files that runs entirely in the
browser. Your documents stay on your device, and you can encrypt them as much
as you need: the whole library, one document, or a single export.

Live: https://maxgfr.github.io/sealoffice

Powered by [ibisOffice](https://github.com/ibisjp/ibis-office).

## What it does

- Opens on a home screen with your documents: create a Word document, an
  Excel workbook or a PowerPoint presentation in one click, or open an
  existing one. Documents show as cards (type, name, date, size) with search,
  sorting and folders.
- Opens, edits and saves `.docx`, `.xlsx` and `.pptx` files with the ibisOffice
  editor compiled to WebAssembly. The editor has an app bar with the document
  name, save state, Share, Download and more.
- Stores documents only in the browser's Origin Private File System (OPFS),
  each one encrypted with [age](https://age-encryption.org).
- Imports plain Office files, password-protected Office files (Agile
  encryption) and age files; downloads as plain Office files, encrypted age
  files or password-protected Office files.
- Works offline after the first load (service worker).
- Saves automatically and keeps the last 10 versions of each document.
- Backs up the whole library as one file, `sealoffice-backup-YYYY-MM-DD.tar.age`,
  and restores it.
- Links a document to an encrypted file on disk and keeps it in sync (Chrome
  and Edge only).
- Shares a document as an encrypted link, with the key in the link or sent
  separately.
- Live sessions (`live.html`): edit a document with others, peer to peer.
  "Shared document" on the home screen starts one on a blank document; its
  invite link is in the address bar (and copied). One person holds the "pen"
  and edits, the others follow; typing takes the pen once the one editing
  has paused for 5 seconds.
- Without WebGPU or WebGL2 the editor cannot run; the page then opens without
  editing (import, export, backup).
- PDF export and printing are not available.

## Encryption, three optional levels

Nothing asks for a passphrase by default. Encryption is there when you want it:

1. **The whole library.** Settings → Protect sets a passphrase for every
   document. The library then opens on a lock screen, and you get a recovery
   key, `sealoffice-recovery-key.txt`, that opens it without the passphrase.
   You can also unlock with a passkey (WebAuthn PRF), if your browser and
   authenticator support it. Protection can be turned off again in Settings.
2. **One document.** A padlock on a document gives it its own passphrase, on
   top of the library. There is no recovery: forget that passphrase and the
   document is lost.
3. **One export.** Download a document as an encrypted age file or as a
   password-protected Office file.

## Security model

- **Unprotected library (the default).** Documents and the index are still
  stored as age ciphertext, but the library key sits in the clear next to
  them (`identity.key`). Anyone who can use this browser profile, or read its
  files, can open your documents. This keeps casual inspection of the storage
  from showing plain files; it is not protection against someone with access
  to your computer.
- **Protected library.** Protecting generates a new age X25519 identity,
  wraps it with your passphrase using age's scrypt recipient, and encrypts
  every document and version again for it. The key that was in the clear then
  opens nothing. The switch is committed in an order that survives a crash or
  a closed tab: the library comes back either as it was or fully protected.
  The passphrase is never stored.
- **Documents.** Each document and the library index are encrypted to the
  library key. Every blob in OPFS is an age file (it starts with
  `age-encryption.org/v1`). The index is authenticated before use, so a
  tampered or swapped blob is reported as an error.
- **Locked documents.** A locked document has its own age identity, wrapped
  with the document passphrase (scrypt) and kept in the index. Its current
  bytes and all its versions are encrypted to that identity only, so the
  library key, the recovery key and the passkey cannot read it. While it is
  open the key stays in memory; it is dropped when you lock the library or
  reload the page. Backups keep locked documents encrypted, and they come back
  locked after a restore.
- **Recovery key.** The recovery key file is the library's age identity in
  plain text. Whoever holds it can read every document (except locked ones)
  and every backup, without the passphrase. Keep it offline. Without the
  passphrase and the recovery key, the only way out is to delete everything
  from the lock screen.
- **Passkey.** A passkey unlock wraps the library key with the output of the
  WebAuthn PRF extension. The wrapped key is stored in OPFS; the PRF output is
  never stored.
- **Encrypted exports.** An age export is encrypted with a passphrase you
  choose for that file; a protected Office export uses Office Agile
  encryption. Both are independent of the library.
- **Share links.** The decryption key travels in the link's `#fragment`,
  which browsers never send to the server. Anyone with the full link can open
  the document. With "separate key", the link carries no key and you send the
  key another way.
- **No network after load.** `index.html` fetches its own code and assets from
  its origin and nothing else. A Content Security Policy restricts scripts,
  connections and frames to the same origin.
- **Live sessions are the exception.** Only `live.html` opens network
  connections, and only while you are in a session. Peers find each other
  through [Trystero](https://github.com/dmotz/trystero) over third-party
  Nostr relays, and connect with WebRTC using public STUN servers. Document
  data goes directly between peers, encrypted. The relays see that a session
  exists and who joins it; peers see each other's IP address. There is no
  TURN relay, so about 1 connection in 10 fails when both sides are behind a
  symmetric NAT.
- **Locking** a protected library drops the keys and reloads the page, which
  clears the editor's memory.

### Limits

- Anyone who controls the origin or the build (a compromised GitHub account,
  repository or Pages deployment) can ship code that reads your passphrase or
  documents. Verify the deployment (below) if that matters to you.
- While a document is open, its key and its contents are in the browser's
  memory in plaintext. Malware on your machine or a malicious browser
  extension can read them.
- The live site shares its origin, `maxgfr.github.io`, with the account's
  other GitHub Pages projects, and OPFS belongs to the origin, not the path.
  A script running on any page of that origin (a bug or a compromised
  dependency in another project) can read the library's files: for an
  unprotected library that includes `identity.key`, so it can open your
  documents. Protect the library, or self-host it on its own origin, if that
  matters to you.
- Clearing site data deletes the library. Make backups, and keep the recovery
  key. On the live site, clearing data for `maxgfr.github.io` clears every
  project's data at once.
- A weak passphrase can be brute-forced from a copy of the library or of a
  locked document. scrypt slows this down; it does not prevent it.

## Verifying a deployment

Each deployment publishes `build-info.json` (source commit, upstream editor
commit, file list, wasm hashes) and `SHA256SUMS`.

Rebuild from the same commit and compare:

```sh
curl -sO https://maxgfr.github.io/sealoffice/SHA256SUMS
scripts/build.sh --release
diff SHA256SUMS dist/SHA256SUMS
```

Builds are not guaranteed to be bit-for-bit reproducible across toolchain
versions. The CI build attests its wasm and JavaScript files; check a
downloaded file against that attestation with the GitHub CLI:

```sh
curl -sO https://maxgfr.github.io/sealoffice/pkg/seal/seal_crypto_bg.wasm
gh attestation verify seal_crypto_bg.wasm --repo maxgfr/sealoffice
```

## Decrypting an export without sealoffice

An age export can be decrypted with the reference
[age](https://github.com/FiloSottile/age) tool, using the passphrase you
chose when exporting:

```sh
age -d -o report.docx report.docx.age
```

A library backup is an age file containing a tar archive, encrypted with the
passphrase you chose for the backup:

```sh
age -d sealoffice-backup-YYYY-MM-DD.tar.age | tar x
```

Locked documents stay encrypted inside the archive; only sealoffice, with the
document passphrase, opens them after a restore.

A file linked on disk is encrypted to the library key; with a protected
library, decrypt it with the recovery key:

```sh
age -d -i sealoffice-recovery-key.txt file.age
```

A password-protected Office export opens in Microsoft Office, LibreOffice or
any tool that supports Office Agile encryption.

## Building from source

Requirements: Rust stable with the `wasm32-unknown-unknown` target,
`wasm-bindgen-cli` 0.2.128 (must match the editor's `Cargo.lock`), bun,
python3, unzip; optionally binaryen's `wasm-opt`.

```sh
git clone --recurse-submodules https://github.com/maxgfr/sealoffice
cd sealoffice
cargo install --locked wasm-bindgen-cli --version 0.2.128
scripts/build.sh --release      # output in dist/
python3 -m http.server -d dist 8080
```

`scripts/build.sh` applies `patches/*.patch` to `vendor/ibis-office` (once),
builds the editor and seal-crypto wasm modules, bundles the page and writes
`dist/build-info.json` and `dist/SHA256SUMS`. `--crypto-only` builds only the
seal-crypto module into `web/src/pkg/seal/` for the unit tests.

Tests:

```sh
cargo test -p seal-crypto
scripts/build.sh --crypto-only && (cd web && bun test)
```

## Credits and license

The document editor is [ibisOffice](https://github.com/ibisjp/ibis-office)
by ibis inc., included as a submodule and modified by the patches in
`patches/`. sealoffice is not affiliated with or endorsed by ibis inc.;
"ibisOffice" is their trademark.

sealoffice is licensed under the GNU Affero General Public License v3.0 only
(`LICENSE`). As required by the additional term under AGPL-3.0 section 7(b)
in ibisOffice's `NOTICE`, the user interface displays "Powered by ibisOffice"
with a link to the upstream repository; derivatives of sealoffice must keep
it. See `NOTICE` and `vendor/ibis-office/www/license.md` for third-party
licenses.
