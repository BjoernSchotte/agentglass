#!/bin/sh
# IBM Plex Sans 400/500/600 and Plex Mono 400/500 subset to Latin + Latin-1 + the punctuation, arrows and glyphs the
# TUI uses (● ◆ ⚠ ○ ▸ ▾ · — … ↵ ⌘ ✓ ✗) → packages/ui/fonts/*.subset.woff2 (committed). Run by hand after a font bump:
#   sh scripts/subset-fonts.sh   (needs npm and pyftsubset from fonttools with brotli)
set -e
here=$(cd "$(dirname "$0")/.." && pwd); w="${XDG_CACHE_HOME:-$HOME/.cache}/agentglass-fonts"; mkdir -p "$w"; cd "$w"
npm pack @ibm/plex-sans@1.1.0 @ibm/plex-mono@2.5.0 > /dev/null
for t in ibm-plex-sans-1.1.0.tgz ibm-plex-mono-2.5.0.tgz; do mkdir -p "${t%.tgz}"; tar -xzf "$t" -C "${t%.tgz}"; done
U="U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201F,U+2022,U+2026,U+2190-2193,U+21B5,U+2318,U+25B8,U+25BE,U+25C6,U+25CB,U+25CF,U+26A0,U+2713,U+2717,U+20AC,U+2264-2265,U+00D7"
out="$here/packages/ui/fonts"
sub() { pyftsubset "$1" --unicodes="$U" --flavor=woff2 --layout-features='kern,liga,tnum,zero' --output-file="$out/$2"; }
pick() { find "$1" -name "$2" | head -1; }
sub "$(pick ibm-plex-sans-1.1.0 'IBMPlexSans-Regular.woff2')" IBMPlexSans-400.subset.woff2
sub "$(pick ibm-plex-sans-1.1.0 'IBMPlexSans-Medium.woff2')" IBMPlexSans-500.subset.woff2
sub "$(pick ibm-plex-sans-1.1.0 'IBMPlexSans-SemiBold.woff2')" IBMPlexSans-600.subset.woff2
sub "$(pick ibm-plex-mono-2.5.0 'IBMPlexMono-Regular.woff2')" IBMPlexMono-400.subset.woff2
sub "$(pick ibm-plex-mono-2.5.0 'IBMPlexMono-Medium.woff2')" IBMPlexMono-500.subset.woff2
cp "$(find ibm-plex-sans-1.1.0 -name 'LICENSE*' | head -1)" "$out/LICENSE-OFL.txt"
ls -la "$out"
