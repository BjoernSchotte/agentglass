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

# Markdown body for the commits in <from>..<to> (from may be empty = all history), grouped by Conventional Commit type.
# Drops chore(release) and merges; a revert and the commit it reverts both drop out when both are in range.
changelog() {
  range="$2"; [ -n "$1" ] && range="$1..$2"
  brk=$(git log --no-merges --grep='BREAKING CHANGE' --format=%H "$range" | tr '\n' ' ')
  git log --no-merges --format='%H%x09%s' "$range" | awk -v brk="$brk" '
    BEGIN { FS = "\t"; n = split(brk, b, " "); for (i = 1; i <= n; i++) B[b[i]] = 1
            name[1] = "Breaking changes"; name[2] = "Features"; name[3] = "Fixes"; name[4] = "Performance"; name[5] = "Refactoring & other"; name[6] = "Docs" }
    { sha[NR] = $1; s[NR] = $2; seen[$2] = 1
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
        sec = (bang || (sha[i] in B)) ? 1 : type == "feat" ? 2 : type == "fix" ? 3 : type == "perf" ? 4 : type == "docs" ? 6 : 5
        out[sec] = out[sec] "- " (scope != "" ? "**" scope ":** " : "") text " (" substr(sha[i], 1, 7) ")\n"
      }
      first = 1
      for (k = 1; k <= 6; k++) if (out[k] != "") { if (!first) printf "\n"; printf "### %s\n\n%s", name[k], out[k]; first = 0 }
      if (first) print "- No changes."
    }'
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
