#!/usr/bin/env bash
# Secret scan for `pnpm check`. Patterns come from publish/deny-patterns.txt (POSIX ERE, `#` comments).
# Scans tracked and untracked-but-not-ignored files; skips docs/refs/ (third-party docs) and the pattern files.
# Also fails if a .env file (other than .env.example) or anything under .data/ is tracked.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
patterns="publish/deny-patterns.txt"
[ -f "$patterns" ] || { echo "secret-scan: $patterns missing" >&2; exit 2; }

fail=0
excludes=(':(exclude)docs/refs/**' ':(exclude)publish/deny-patterns.txt' ':(exclude)publish/leak-patterns.txt' ':(exclude)pnpm-lock.yaml')
while IFS= read -r p || [ -n "$p" ]; do
  case "$p" in ''|'#'*) continue ;; esac
  if hits="$(git grep --untracked -n -I -E -e "$p" -- . "${excludes[@]}" 2>/dev/null)"; then
    echo "secret-scan: pattern matched: $p" >&2
    echo "$hits" | cut -c1-160 >&2
    fail=1
  fi
done < "$patterns"

if bad="$(git ls-files | grep -E '(^|/)\.env(\..+)?$' | grep -vE '(^|/)\.env\.example$')"; then
  echo "secret-scan: tracked env file(s):" >&2; echo "$bad" >&2; fail=1
fi
if bad="$(git ls-files | grep -E '(^|/)\.data/')"; then
  echo "secret-scan: tracked .data file(s):" >&2; echo "$bad" >&2; fail=1
fi

if [ "$fail" -ne 0 ]; then echo "secret-scan: FAILED" >&2; exit 1; fi
echo "secret-scan: ok"
