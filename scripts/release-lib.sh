# agentglass release helpers — sourced by release.sh, the release workflows and release-lib.test.sh (POSIX sh + git + awk)
# stable versions are YYYY.M.N (N counts releases within the UTC month), tags v<version>

_stable_re='^v[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]*$'

# stable versions on stdin → ascending by (year, month, N), numerically
sort_versions() {
  awk -F. 'NF==3 {printf "%06d %04d %06d %s\n", $1, $2, $3, $0}' | sort | cut -d' ' -f4
}

# next version for a UTC month prefix (default: now), e.g. "2026.9" → 2026.9.4 after v2026.9.3
next_version() {
  prefix="${1:-$(date -u +%Y).$(date -u +%m | sed 's/^0//')}"
  last=$(git tag -l "v$prefix.*" | grep -E "$_stable_re" | sed 's/^v//' | sort_versions | tail -1)
  if [ -z "$last" ]; then echo "$prefix.1"; else echo "$prefix.$(( ${last##*.} + 1 ))"; fi
}

# newest stable tag reachable from a ref (by version, never by date), empty if none
last_stable_tag() {
  git tag --merged "${1:-HEAD}" -l 'v*' | grep -E "$_stable_re" | sed 's/^v//' | sort_versions | tail -1 | sed 's/^./v&/'
}

# who is not credited under Contributors: GitHub logins and git author names (comma-separated); bots ("[bot]") never are
RELEASE_MAINTAINERS="${RELEASE_MAINTAINERS:-BjoernSchotte}"
RELEASE_MAINTAINER_NAMES="${RELEASE_MAINTAINER_NAMES:-Björn Schotte}"

# GitHub metadata for the commits in <range>, one line each: "<sha>\t<merged PR> <PR author>\t<commit author login>".
# Prints nothing offline (RELEASE_OFFLINE=1) or without gh; a failed lookup leaves its fields empty (notes fall back to git names).
_gh_meta() {
  [ "${RELEASE_OFFLINE:-0}" = 1 ] && return 0
  gh="${RELEASE_GH:-gh}"; command -v "$gh" >/dev/null 2>&1 || return 0
  repo="${RELEASE_REPO:-${GITHUB_REPOSITORY:-BjoernSchotte/agentglass}}"
  for sha in $(git log --no-merges --format=%H "$1"); do
    pr=$("$gh" api "repos/$repo/commits/$sha/pulls" --jq 'map(select(.merged_at != null)) | first // empty | "\(.number) \(.user.login)"' 2>/dev/null) || pr=""
    login=$("$gh" api "repos/$repo/commits/$sha" --jq '.author.login // ""' 2>/dev/null) || login=""
    printf '%s\t%s\t%s\n' "$sha" "$pr" "$login"
  done
}

# Markdown body for the commits in <from>..<to> (from may be empty = all history), grouped by Conventional Commit type.
# Drops chore(release) and merges; a revert and the commit it reverts both drop out when both are in range.
# With GitHub metadata, entries link their merged PR and a Contributors section credits everyone but the maintainers.
changelog() {
  range="$2"; [ -n "$1" ] && range="$1..$2"
  brk=$(git log --no-merges --grep='BREAKING CHANGE' --format=%H "$range" | tr '\n' ' ')
  meta=$(mktemp); _gh_meta "$range" > "$meta"
  git log --no-merges --format='%H%x09%s%x09%an' "$range" | awk -v brk="$brk" -v meta="$meta" \
    -v repo="${RELEASE_REPO:-${GITHUB_REPOSITORY:-BjoernSchotte/agentglass}}" -v mlog="$RELEASE_MAINTAINERS" -v mname="$RELEASE_MAINTAINER_NAMES" '
    function credit(who, n) {
      if (who == "" || who ~ /\[bot\]/ || (who in M)) return
      if (!(who in C)) { C[who] = ""; order[++nc] = who }
      if (n != "" && index(" " C[who] " ", " " n " ") == 0) C[who] = C[who] (C[who] == "" ? "" : " ") n
    }
    function key(w) { sub(/^@/, "", w); return tolower(w) } # alphabetical, @ ignored
    function prlink(n) { return "[#" n "](https://github.com/" repo "/pull/" n ")" }
    BEGIN { FS = "\t"; n = split(brk, b, " "); for (i = 1; i <= n; i++) B[b[i]] = 1
            n = split(mlog, b, ","); for (i = 1; i <= n; i++) M["@" b[i]] = 1
            n = split(mname, b, ","); for (i = 1; i <= n; i++) M[b[i]] = 1
            while ((getline l < meta) > 0) { split(l, f, "\t"); split(f[2], p, " "); PR[f[1]] = p[1]; PA[f[1]] = p[2]; AL[f[1]] = f[3] }
            name[1] = "Breaking changes"; name[2] = "Features"; name[3] = "Fixes"; name[4] = "Performance"; name[5] = "Build & CI"
            name[6] = "Refactoring & other"; name[7] = "Docs" }
    { sha[NR] = $1; s[NR] = $2; an[NR] = $3; seen[$2] = 1
      if ($2 ~ /^Revert "/) { t = $2; sub(/^Revert "/, "", t); sub(/"$/, "", t); reverted[t] = 1; isrev[NR] = t } }
    END {
      for (i = 1; i <= NR; i++) {
        subj = s[i]
        if (subj ~ /^chore\(release\)/) continue
        if ((i in isrev) && (isrev[i] in seen)) continue
        if (subj in reverted) continue
        type = "other"; scope = ""; text = subj; bang = 0
        if (match(subj, /^[a-z]+(\([^)]*\))?!?: /)) {
          head = substr(subj, 1, RLENGTH - 2); text = substr(subj, RLENGTH + 1)
          if (head ~ /!$/) { bang = 1; head = substr(head, 1, length(head) - 1) }
          if (match(head, /\(.*\)/)) { scope = substr(head, RSTART + 1, RLENGTH - 2); head = substr(head, 1, RSTART - 1) }
          type = head
        }
        sec = (bang || (sha[i] in B)) ? 1 : type == "feat" ? 2 : type == "fix" ? 3 : type == "perf" ? 4 : (type == "build" || type == "ci") ? 5 : type == "docs" ? 7 : 6
        pr = PR[sha[i]]
        out[sec] = out[sec] "- " (scope != "" ? "**" scope ":** " : "") text " (" substr(sha[i], 1, 7) (pr != "" ? ", " prlink(pr) : "") ")\n"
        credit(AL[sha[i]] != "" ? "@" AL[sha[i]] : an[i], pr)
        if (PA[sha[i]] != "") credit("@" PA[sha[i]], pr)
      }
      first = 1
      for (k = 1; k <= 7; k++) if (out[k] != "") { if (!first) printf "\n"; printf "### %s\n\n%s", name[k], out[k]; first = 0 }
      if (first) print "- No changes."
      if (nc > 0) {
        printf "\n### Contributors\n\n"
        for (i = 2; i <= nc; i++) { w = order[i]; for (j = i - 1; j >= 1 && key(order[j]) > key(w); j--) order[j + 1] = order[j]; order[j + 1] = w }
        for (i = 1; i <= nc; i++) {
          w = order[i]; ln = ""; m = split(C[w], q, " ")
          for (j = 1; j <= m; j++) ln = ln (j > 1 ? ", " : "") prlink(q[j])
          print "- " w (ln != "" ? " (" ln ")" : "")
        }
      }
    }'
  rc=$?; rm -f "$meta"; return $rc
}

# the "## <version>" section of CHANGELOG.md without its heading (leading/trailing blank lines trimmed)
notes_for() {
  [ -f CHANGELOG.md ] || return 0
  awk -v h="## $1" '$0 == h { f = 1; next } f && /^## / { exit } f { print }' CHANGELOG.md |
    awk 'NF { found = 1 } found { buf[++n] = $0 } END { while (n > 0 && buf[n] == "") n--; for (i = 1; i <= n; i++) print buf[i] }'
}

# insert "## <version>" + body under CHANGELOG.md's 3-line header (title, blank, intro)
prepend_changelog() {
  tmp=$(mktemp)
  {
    head -3 CHANGELOG.md
    printf '\n## %s\n\n%s\n' "$1" "$2"
    rest=$(tail -n +4 CHANGELOG.md | sed '/./,$!d')
    [ -z "$rest" ] || printf '\n%s\n' "$rest"
  } > "$tmp"
  mv "$tmp" CHANGELOG.md
}
