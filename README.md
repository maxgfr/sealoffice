# sealoffice

An office suite (Word, Excel and PowerPoint files) that runs entirely in the
browser and keeps every document in an encrypted local vault.

Live: https://maxgfr.github.io/sealoffice

Powered by [ibisOffice](https://github.com/ibisjp/ibis-office).

## What it does

- Opens, edits and saves `.docx`, `.xlsx` and `.pptx` files with the ibisOffice
  editor compiled to WebAssembly.
- Stores documents only in the browser's Origin Private File System (OPFS),
  each one encrypted with [age](https://age-encryption.org).
- Imports plain Office files, password-protected Office files (Agile
  encryption) and age files; exports as age files, password-protected Office
  files, or plain Office files.
- Works offline after the first load (service worker).

## Security model

- **Vault key.** Creating a vault generates an age X25519 identity. The
  identity is wrapped with your passphrase using age's scrypt recipient and
  stored in OPFS. The passphrase is never stored.
- **Documents.** Each document and the vault index are encrypted to the vault
  key. Every blob in OPFS is an age file (it starts with
  `age-encryption.org/v1`). The index is authenticated before use, so a
  tampered or swapped blob is reported as an error.
- **No network after load.** The page fetches its own code and assets from
  its origin and nothing else. A Content Security Policy restricts scripts,
  connections and frames to the same origin.
- **Locking** drops the key and reloads the page, which clears the editor's
  memory.

### Limits

- Anyone who controls the origin or the build (a compromised GitHub account,
  repository or Pages deployment) can ship code that reads your passphrase or
  documents. Verify the deployment (below) if that matters to you.
- While the vault is unlocked, the key and the open document are in the
  browser's memory in plaintext. Malware on your machine or a malicious
  browser extension can read them.
- Clearing site data deletes the vault. Export what you want to keep.
- A weak passphrase can be brute-forced from a copy of the vault. scrypt slows
  this down; it does not prevent it.

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
