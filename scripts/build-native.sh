#!/bin/sh
# Build + ad-hoc sign every native helper with a STABLE code-signing
# identifier, so macOS TCC grants survive rebuilds (DESIGN.md §2, §3.5).
set -eu

sign_id_prefix="io.github.hanlunwang.apple-suite-mcp"

for helper in eventkit-helper contacts-helper; do
  echo "==> building ${helper}"
  swift build --package-path "native/${helper}" -c release
  codesign --force -s - \
    --identifier "${sign_id_prefix}.${helper}" \
    "native/${helper}/.build/release/${helper}"
done
