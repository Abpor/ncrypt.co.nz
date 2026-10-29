#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output="$root/public"

[ "$output" = "$root/public" ] || exit 1
rm -rf "$output"
mkdir -p "$output"

for path in \
  404.html \
  assets \
  creatorops \
  crossborder \
  index.html \
  lithotraq \
  llm.txt \
  policyproof \
  robots.txt \
  sitemap.xml \
  tools
do
  cp -R "$root/$path" "$output/$path"
done
