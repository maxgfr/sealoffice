#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Build sealoffice into dist/.
#
#   scripts/build.sh                 debug build of everything
#   scripts/build.sh --release       release build (plus wasm-opt when installed)
#   scripts/build.sh --crypto-only   only build the seal-crypto wasm into web/src/pkg/seal/
#
# Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli 0.2.128, bun,
# unzip, python3. Optional: wasm-opt (binaryen).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

WASM_BINDGEN_VERSION=0.2.128
PROFILE=debug
FLAGS=()
CRYPTO_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --release) PROFILE=release; FLAGS=(--release) ;;
    --crypto-only) CRYPTO_ONLY=1 ;;
    -h|--help) sed -n '3,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

if command -v sha256sum >/dev/null; then
  sha256() { sha256sum "$@"; }
elif command -v shasum >/dev/null; then
  sha256() { shasum -a 256 "$@"; }
else
  die "neither sha256sum nor shasum is installed"
fi

command -v wasm-bindgen >/dev/null || die "wasm-bindgen not found; run: cargo install --locked wasm-bindgen-cli --version $WASM_BINDGEN_VERSION"
have=$(wasm-bindgen --version | awk '{print $2}')
[[ "$have" == "$WASM_BINDGEN_VERSION" ]] || die "wasm-bindgen $have installed, $WASM_BINDGEN_VERSION required (cargo install --locked wasm-bindgen-cli --version $WASM_BINDGEN_VERSION)"

REMAP="--remap-path-prefix=$HOME/.cargo/registry/src=crates.io --remap-path-prefix=$HOME/.cargo/git/checkouts=git --remap-path-prefix=$HOME/.rustup=rustup"

# --- seal-crypto wasm -------------------------------------------------------
echo "==> seal-crypto ($PROFILE)"
RUSTFLAGS="$REMAP --remap-path-prefix=$ROOT=." \
  cargo build -p seal-crypto --target wasm32-unknown-unknown ${FLAGS[@]+"${FLAGS[@]}"}
SEAL_WASM="target/wasm32-unknown-unknown/$PROFILE/seal_crypto.wasm"
[[ -f "$SEAL_WASM" ]] || die "missing $SEAL_WASM"
rm -rf web/src/pkg/seal
wasm-bindgen "$SEAL_WASM" --out-dir web/src/pkg/seal --target web

if [[ "$CRYPTO_ONLY" == 1 ]]; then
  echo "Built web/src/pkg/seal/ ($PROFILE)."
  exit 0
fi

command -v bun >/dev/null || die "bun not found"
command -v unzip >/dev/null || die "unzip not found"
command -v python3 >/dev/null || die "python3 not found"

# --- vendor patches ---------------------------------------------------------
VENDOR=vendor/ibis-office
[[ -f "$VENDOR/Cargo.toml" ]] || die "$VENDOR is empty; run: git submodule update --init --recursive"
shopt -s nullglob
for patch in patches/*.patch; do
  abs="$ROOT/$patch"
  if git -C "$VENDOR" apply --reverse --check "$abs" 2>/dev/null; then
    echo "==> $patch already applied"
  else
    echo "==> applying $patch"
    git -C "$VENDOR" apply "$abs" || die "$patch does not apply to $VENDOR"
  fi
done
shopt -u nullglob
# The bold and italic UI faces the patched web build embeds (IBM Plex Sans, OFL).
cp fonts/IBMPlexSans-{Bold,Italic,BoldItalic}.ttf "$VENDOR/crates/ibis-office-app/fonts/"

# --- editor wasm ------------------------------------------------------------
echo "==> editor ($PROFILE)"
# wasm_thread needs a nightly feature on wasm32; allow it for that crate only.
# The rest mirrors upstream's scripts/dist-profile.sh: the release defaults (its
# Cargo.toml's release profile is for development) and no menu lines that are
# not made yet.
(
  cd "$VENDOR"
  export CARGO_PROFILE_RELEASE_INCREMENTAL=false CARGO_PROFILE_RELEASE_LTO=false IBIS_OFFICE_DIST=1
  RUSTC_BOOTSTRAP=wasm_thread RUSTFLAGS="$REMAP --remap-path-prefix=$(pwd)=." CARGO_TARGET_DIR=target/dist \
    cargo rustc -p ibis-office-app --lib --crate-type cdylib --target wasm32-unknown-unknown ${FLAGS[@]+"${FLAGS[@]}"} -- \
    -C link-arg=-zstack-size=8388608
)
EDITOR_WASM="$VENDOR/target/dist/wasm32-unknown-unknown/$PROFILE/ibis_office_app.wasm"
[[ -f "$EDITOR_WASM" ]] || die "missing $EDITOR_WASM"

rm -rf dist
mkdir -p dist/pkg dist/assets
wasm-bindgen "$EDITOR_WASM" --out-dir dist/pkg/editor --target web
cp -R web/src/pkg/seal dist/pkg/seal

# --- seal-pdf wasm ----------------------------------------------------------
# PDF export (office2pdf and Typst, fonts embedded). Not precached: the page
# downloads and compiles it on the first PDF export, and both the page and the
# service worker check it against build-info.json's sha256 and SHA256SUMS.
echo "==> seal-pdf ($PROFILE)"
RUSTFLAGS="$REMAP --remap-path-prefix=$ROOT=." \
  cargo build -p seal-pdf --target wasm32-unknown-unknown ${FLAGS[@]+"${FLAGS[@]}"}
PDF_WASM="target/wasm32-unknown-unknown/$PROFILE/seal_pdf.wasm"
[[ -f "$PDF_WASM" ]] || die "missing $PDF_WASM"
wasm-bindgen "$PDF_WASM" --out-dir dist/pkg/pdf --target web

if [[ "$PROFILE" == release ]]; then
  if command -v wasm-opt >/dev/null; then
    for w in dist/pkg/editor/ibis_office_app_bg.wasm dist/pkg/seal/seal_crypto_bg.wasm dist/pkg/pdf/seal_pdf_bg.wasm; do
      echo "==> wasm-opt $w"
      wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int "$w" -o "$w"
    done
  else
    echo "note: wasm-opt not found; wasm files are not size-optimised" >&2
  fi
fi
# Uncompressed size for the download progress bar (Pages serves gzip).
wc -c < dist/pkg/editor/ibis_office_app_bg.wasm | tr -d ' ' > dist/pkg/editor/ibis_office_app_bg.wasm.size

# --- assets (icons, art borders) -------------------------------------------
ICONS_DIR=$(cd "$VENDOR" && cargo metadata --format-version 1 | python3 -c '
import json, os, sys
meta = json.load(sys.stdin)
pkg = next(p for p in meta["packages"] if p["name"] == "gpui-kit-assets")
print(os.path.join(os.path.dirname(pkg["manifest_path"]), "assets", "icons"))')
[[ -d "$ICONS_DIR" ]] || die "icons not found at $ICONS_DIR"
cp -R "$ICONS_DIR" dist/assets/icons
mkdir -p dist/assets/artborders
unzip -q -o "$VENDOR/crates/ibis-pptx/data/artborders/OfficeOpenXML-WordprocessingMLArtBorders.zip" -d dist/assets/artborders
cp "$VENDOR/crates/ibis-pptx/data/artborders/ECMA-NOTICE.txt" dist/assets/artborders/

# --- web page ---------------------------------------------------------------
echo "==> web"
if [[ -f web/bun.lock || -f web/bun.lockb ]]; then
  (cd web && bun install --frozen-lockfile)
else
  (cd web && bun install)
fi
# --splitting: the live session code (and Trystero) is a chunk only live.html loads.
bun build web/src/main.ts --outdir dist --minify --target browser --splitting
bun build web/src/sw.ts --outfile dist/sw.js --minify --target browser
# The worker each PDF conversion runs in.
bun build web/src/pdfworker.ts --outfile dist/pdf-worker.js --minify --target browser
cp web/index.html dist/
[[ -f web/live.html ]] || die "missing web/live.html"
cp web/live.html dist/
for css in web/src/*.css; do
  [[ -e "$css" ]] && cp "$css" dist/
done
if [[ -d web/public ]]; then cp -R web/public/. dist/; fi
cp LICENSE NOTICE dist/
cp "$VENDOR/www/license.md" dist/third-party-licenses.md
# The PDF converter is ours, not the editor's: list its crates and the notices
# of the fonts it embeds after upstream's list.
cargo metadata --format-version 1 --filter-platform wasm32-unknown-unknown | python3 -c '
import json, os, sys
meta = json.load(sys.stdin)
pkgs = {p["id"]: p for p in meta["packages"]}
nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
root = next(i for i, p in pkgs.items() if p["name"] == "seal-pdf")
seen, todo = set(), [root]
while todo:
    for dep in nodes[todo.pop()]["deps"]:
        # Normal dependencies only: build scripts and proc macros are not in the wasm.
        macro = any("proc-macro" in t["kind"] for t in pkgs[dep["pkg"]]["targets"])
        if any(k["kind"] is None for k in dep["dep_kinds"]) and not macro and dep["pkg"] not in seen:
            seen.add(dep["pkg"])
            todo.append(dep["pkg"])
crates = sorted((pkgs[i] for i in seen), key=lambda p: (p["name"], p["version"]))
out = ["", "## sealoffice PDF export (`pkg/pdf/`, crates/seal-pdf)", "",
       "Word, Excel and PowerPoint files are converted to PDF in the page by office2pdf and Typst.", "",
       f"### Rust crates ({len(crates)})", "", "| Name | Version | License | Source |", "|---|---|---|---|"]
out += ["| {} | {} | {} | {} |".format(p["name"], p["version"], p.get("license") or "see source", p.get("repository") or "") for p in crates]
by_name = {p["name"]: os.path.dirname(p["manifest_path"]) for p in crates}
for crate, files in [("typst-assets", ["NOTICE"]), ("office2pdf", ["fonts/OFL-1.1.txt", "fonts/Selawik-LICENSE.txt"])]:
    for f in files:
        with open(os.path.join(by_name[crate], f), encoding="utf-8") as fh:
            out += ["", f"### {crate}: {f}", "", "```", fh.read().rstrip(), "```"]
print("\n".join(out))
' >> dist/third-party-licenses.md

for f in dist/index.html dist/live.html dist/main.js dist/sw.js dist/pdf-worker.js dist/pkg/editor/ibis_office_app_bg.wasm dist/pkg/seal/seal_crypto_bg.wasm dist/pkg/pdf/seal_pdf_bg.wasm; do
  [[ -f "$f" ]] || die "missing $f"
done

# --- build info and checksums ----------------------------------------------
LISTING=$(mktemp)
trap 'rm -f "$LISTING"' EXIT
VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' web/package.json | head -n1)
COMMIT=$(git rev-parse --verify -q HEAD 2>/dev/null || echo unknown)
UPSTREAM_COMMIT=$(git -C "$VENDOR" rev-parse --verify -q HEAD 2>/dev/null || echo unknown)
EDITOR_SHA=$(sha256 dist/pkg/editor/ibis_office_app_bg.wasm | awk '{print $1}')
SEAL_SHA=$(sha256 dist/pkg/seal/seal_crypto_bg.wasm | awk '{print $1}')
PDF_SHA=$(sha256 dist/pkg/pdf/seal_pdf_bg.wasm | awk '{print $1}')

(cd dist && find . -type f ! -name SHA256SUMS ! -name build-info.json | sed 's|^\./||' | LC_ALL=C sort) > "$LISTING"
python3 - "$VERSION" "$COMMIT" "$UPSTREAM_COMMIT" "$EDITOR_SHA" "$SEAL_SHA" "$PDF_SHA" "$LISTING" > dist/build-info.json <<'PY'
import json, sys
version, commit, upstream, editor, seal, pdf, listing = sys.argv[1:]
with open(listing) as f:
    files = [line.strip() for line in f if line.strip()]
json.dump({
    "version": version or "0.0.0",
    "commit": commit,
    "upstreamCommit": upstream,
    "files": files,
    "sha256": {
        "pkg/editor/ibis_office_app_bg.wasm": editor,
        "pkg/seal/seal_crypto_bg.wasm": seal,
        "pkg/pdf/seal_pdf_bg.wasm": pdf,
    },
}, sys.stdout, indent=2)
print()
PY

(cd dist && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do sha256 "$f"; done) > dist/SHA256SUMS

echo
echo "Built dist/ ($PROFILE)"
echo "  editor wasm sha256: $EDITOR_SHA"
echo "  seal wasm sha256:   $SEAL_SHA"
echo "  pdf wasm sha256:    $PDF_SHA"
echo "Serve it, e.g.: python3 -m http.server -d dist 8080"
