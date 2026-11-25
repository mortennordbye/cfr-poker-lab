#!/usr/bin/env bash
# Builds the Rust postflop engine (engines/postflop/rs) as WebAssembly for the static site (browser mode).
# Output: engines/postflop/rs/target/web/{mt,st}/ (wasm-bindgen --target web). tools/build-web.js copies it to dist/.
#
#   mt  threads: rayon on Web Workers (wasm-bindgen-rayon). Needs Rust nightly, because the standard library is
#       built again with atomics (-Z build-std). The nightly is pinned to a date (NIGHTLY below), so builds repeat.
#       The page uses it when it is cross-origin isolated (SharedArrayBuffer, public/browser/sw.js).
#   st  one thread, stable Rust. The page uses it without cross-origin isolation. Same results, slower.
#
# Needs rustup. The script installs what is missing: the wasm32-unknown-unknown target (stable), the pinned nightly
# with rust-src, and wasm-bindgen-cli at the version of the wasm-bindgen crate in Cargo.lock.
# ONLY=st (or ONLY=mt) builds one version. Usage: tools/build-wasm.sh
set -euo pipefail

# Pinned nightly for the threaded build. Tested: builds postflop-solver 9d1509fe with wasm-bindgen 0.2.130 and
# wasm-bindgen-rayon 1.3.0. Change it only together with a browser test (README of engines/postflop).
NIGHTLY="${WASM_NIGHTLY:-nightly-2026-11-15}"
ONLY="${ONLY:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RS="$ROOT/engines/postflop/rs"
OUT="$RS/target/web"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
cd "$RS"

# wasm-bindgen-cli must match the crate version exactly.
want="$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/version = |"/, ""); print }' Cargo.lock)"
have="$(wasm-bindgen --version 2>/dev/null | awk '{ print $2 }' || true)"
if [ "$have" != "$want" ]; then
  echo "installing wasm-bindgen-cli $want (found: ${have:-none})"
  cargo +stable install wasm-bindgen-cli --version "$want" --locked
fi

# panic=abort: WebAssembly has no unwinding. +simd128: postflop-solver has SIMD code for wasm32.
PROFILE=(--release --locked --lib --crate-type cdylib --target wasm32-unknown-unknown --no-default-features
  --config 'profile.release.panic="abort"')

if [ "$ONLY" != "mt" ]; then
  rustup target add wasm32-unknown-unknown --toolchain stable >/dev/null
  echo "building st (stable, one thread)"
  RUSTFLAGS="-C target-feature=+simd128" \
    cargo +stable rustc "${PROFILE[@]}" --target-dir target/wasm-st
  rm -rf "$OUT/st"
  wasm-bindgen --target web --out-dir "$OUT/st" target/wasm-st/wasm32-unknown-unknown/release/postflop_engine.wasm
fi

if [ "$ONLY" != "st" ]; then
  if ! rustup run "$NIGHTLY" rustc --version >/dev/null 2>&1 \
    || [ ! -d "$(rustup run "$NIGHTLY" rustc --print sysroot)/lib/rustlib/src/rust/library" ]; then
    echo "installing $NIGHTLY with rust-src"
    rustup toolchain install "$NIGHTLY" --profile minimal --component rust-src
  fi
  echo "building mt ($NIGHTLY, threads)"
  # Shared memory up to 4 GB (wasm32 limit), imported so the rayon workers use the same memory, and the TLS exports
  # that wasm-bindgen needs for threads. This rustc does not add these linker flags by itself for +atomics.
  LINK="-C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=4294967296"
  LINK="$LINK -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size"
  LINK="$LINK -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base"
  RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 $LINK" \
    cargo "+$NIGHTLY" rustc "${PROFILE[@]}" --features wasm-threads --target-dir target/wasm-mt \
    -Z build-std=panic_abort,std
  rm -rf "$OUT/mt"
  wasm-bindgen --target web --out-dir "$OUT/mt" target/wasm-mt/wasm32-unknown-unknown/release/postflop_engine.wasm
fi

ls -l "$OUT"/*/postflop_engine_bg.wasm
