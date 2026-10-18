#!/usr/bin/env bash
# Run every harness. Exits non-zero if any fails.
#   tools/check.sh
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
for t in checksource checkmath checkrotate; do
  [ -f "tools/$t.js" ] || continue
  out=$(node "tools/$t.js" 2>&1); rc=$?
  tail=$(echo "$out" | tail -1)
  if [ $rc -ne 0 ]; then
    printf '  \033[31mFAIL\033[0m  %-14s %s\n' "$t" "$tail"
    echo "$out" | grep -E '^\s+FAIL' | head -20
    fail=1
  else
    printf '  \033[32mok\033[0m    %-14s %s\n' "$t" "$tail"
  fi
done
[ $fail -eq 0 ] && echo "all green" || echo "SOMETHING IS RED"
exit $fail
