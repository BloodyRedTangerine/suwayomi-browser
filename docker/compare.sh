#!/usr/bin/env bash
# Compare two build output directories: file-by-file (diff -r) and by sorted per-file SHA-256 manifests; ZIPs byte-for-byte.
set -euo pipefail
A="$1"; B="$2"; status=0
for target in firefox chrome; do
  diff -r "$A/$target" "$B/$target" > /dev/null && echo "diff -r $target: identical" || { echo "diff -r $target: DIFFERENT"; status=1; }
  cmp "$A/files-$target.sha256" "$B/files-$target.sha256" && echo "manifest $target: identical" || { echo "manifest $target: DIFFERENT"; status=1; }
done
for zip in "$A"/*.zip; do
  name="$(basename "$zip")"
  cmp "$zip" "$B/$name" && echo "zip $name: byte-identical" || { echo "zip $name: DIFFERENT"; status=1; }
done
cmp "$A/SHA256SUMS" "$B/SHA256SUMS" && echo "SHA256SUMS: identical" || { echo "SHA256SUMS: DIFFERENT"; status=1; }
exit "$status"
