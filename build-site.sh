#!/usr/bin/env bash
# Build dist/ for GitHub Pages (Omarchy Themes site).
#
# Produces:
#   dist/index.html       (copied as-is)
#   dist/sw.js            (copied as-is)
#   dist/wallpapers.js    (window.WALLPAPERS = {...};  with base URL injected)
#
# index.html reads window.WALLPAPERS_BASE_URL at load and prefixes every
# relative thumb_path / medium_path / background / colors_toml / neovim_lua
# with it. The base URL comes from $WALLPAPERS_BASE_URL.
set -euo pipefail
cd "$(dirname "$0")"

BASE="${WALLPAPERS_BASE_URL:-${HETZNER_PUBLIC_BASE:-}}"
if [ -z "$BASE" ]; then
  echo "warn: no WALLPAPERS_BASE_URL / HETZNER_PUBLIC_BASE set. Building with relative paths." >&2
fi

OUT=dist
rm -rf "$OUT"
mkdir -p "$OUT"

cp index.html "$OUT/"
cp sw.js "$OUT/"
# Static assets the page references: Omarchy logo + Cascadia Code fonts.
# Skipped silently if missing so a partial checkout still builds.
[ -f favicon.png ]          && cp favicon.png          "$OUT/"
[ -f apple-touch-icon.png ] && cp apple-touch-icon.png "$OUT/"
[ -d fonts ]                && cp -r fonts             "$OUT/"

# wallpapers.json is theme-keyed here (one entry per omarchy theme variant).
{
  printf 'window.WALLPAPERS_BASE_URL = %s;\n' "$(printf %s "$BASE" | jq -Rs .)"
  printf 'window.WALLPAPERS = '; cat wallpapers.json; printf ';\n'
} > "$OUT/wallpapers.js"

# .nojekyll so GitHub Pages serves files with leading underscores etc. verbatim.
touch "$OUT/.nojekyll"

echo "built -> $OUT/"
echo "  base url: ${BASE:-<none, relative>}"
du -sh "$OUT"/* 2>/dev/null || true
