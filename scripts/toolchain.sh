# sourced by build.sh / check.sh: puts a Node 24+ with scriptc on PATH and checks for clang
# (scriptc needs Node 24+ to build, not to run)
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# scriptc + Node 24+ on PATH wins; else the newest nvm-installed Node 24+ that has scriptc
if ! command -v scriptc >/dev/null 2>&1 || [ "$(node_major "$(command -v node || echo node)")" -lt 24 ]; then
  for d in $(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -rV); do
    if [ -x "$d/scriptc" ] && [ "$(node_major "$d/node")" -ge 24 ]; then PATH="$d:$PATH"; break; fi
  done
fi

command -v scriptc >/dev/null 2>&1 || { echo "scriptc not found — npm i -g scriptc (with Node 24+)" >&2; exit 1; }
[ "$(node_major "$(command -v node)")" -ge 24 ] || { echo "Node 24+ required to build (found $(node -v 2>/dev/null || echo none))" >&2; exit 1; }
# scriptc links with clang (-target); gcc can't stand in
command -v "${SCRIPTC_LINKER:-clang}" >/dev/null 2>&1 || { echo "clang not found — Linux: apt install clang / dnf install clang, macOS: xcode-select --install" >&2; exit 1; }
