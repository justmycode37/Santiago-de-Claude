#!/usr/bin/env bash
# Renders the PNG app icons in icons/ from icons/icon.svg (needs rsvg-convert, from librsvg).
# Run it after changing icon.svg and commit the PNGs: the build copies icons/ as it is.
set -euo pipefail
cd "$(dirname "$0")/../icons"
rsvg-convert -w 192 -h 192 icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
# iOS rounds the corners itself and shows transparent ones black: a full-bleed square.
sed -e 's/ rx="112"//' icon.svg | rsvg-convert -w 180 -h 180 -o apple-touch-icon.png
# Maskable: full-bleed square (the launcher cuts its own shape), the pin scaled down so all of it lies inside the
# central safe zone, a circle of 40% of the width.
sed -e 's/ rx="112"//' -e 's/<g id="glyph">/<g id="glyph" transform="translate(256 256) scale(.8) translate(-256 -256)">/' icon.svg \
  | rsvg-convert -w 512 -h 512 -o maskable-512.png
echo "wrote icons/*.png"
