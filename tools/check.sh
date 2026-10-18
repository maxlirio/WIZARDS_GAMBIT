#!/usr/bin/env bash
# Run every harness. Exits non-zero if any fails.
#
#   tools/check.sh            the full suite
#   tools/check.sh --quick    the fast half, for an edit-run loop
#
# ORDER MATTERS. checksource comes first because it is a grep and costs
# nothing, and because a Math.sqrt that got into the field makes every number
# below it untrustworthy rather than merely wrong. The two gates -- checkchains
# and verify-faces --selftest -- come before the long play harnesses, because a
# chain that might not terminate and a conformance checker that catches nothing
# make a clean playtest run meaningless.
set -uo pipefail
cd "$(dirname "$0")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

# name|args|what it proves
SUITE=(
  "checksource||no Math.sqrt outside fixed.js, no host globals in the engine"
  "checkmath||integer arithmetic, the direction table, the seeded rng"
  "checkrotate||the orientation algebra and the 16-vertex lattice"
  "checkrunes|--tables 60000|rune distribution and the chain-length curve"
  "checkcorpus||every gate, cost, keyword, formula and motif is on a card"
  "checkchains|--fuzz 300|THE GATE: chains terminate, replay identically"
  "verify-faces|--selftest|THE GATE: every face against its printed text"
  "checkderived|--games 6|every derived bucket is both written and read"
  "checkledger|--games 6|every ledger counter is both written and read"
  "checkfield|--seeds 14|field determinism, drift, falls, candidate stability"
  "playtest|--games 20 --cap 3000 --pool|whole matches, invariants after every decision"
  "checklockstep|--games 10 --child 3|two engines, identical hash after every move"
)
# The long runs. Skipped by --quick.
SLOW=(
  "playtest|--games 120 --cap 4000 --pool|the full random sweep"
  "checklockstep|--games 60 --child 6|the full desync sweep"
)

fail=0
run_one() {
  local name="$1" args="$2" what="$3"
  [ -f "tools/$name.js" ] || return 0
  local out rc tail
  out=$(node "tools/$name.js" $args 2>&1); rc=$?
  tail=$(echo "$out" | grep -E '^[0-9]+ (passed|failure)|^all |^[0-9]+ failures?$' | tail -1)
  [ -z "$tail" ] && tail=$(echo "$out" | tail -1)
  if [ $rc -ne 0 ]; then
    printf '  \033[31mFAIL\033[0m  %-16s %s\n' "$name" "$tail"
    echo "$out" | grep -E '(^|  )(FAIL|ESCAPED)' | head -12 | sed 's/^/        /'
    fail=1
  else
    printf '  \033[32mok\033[0m    %-16s %-28s \033[2m%s\033[0m\n' "$name" "$tail" "$what"
  fi
}

for entry in "${SUITE[@]}"; do
  IFS='|' read -r name args what <<< "$entry"
  run_one "$name" "$args" "$what"
done

if [ $QUICK -eq 0 ]; then
  echo "  --- the long runs (tools/check.sh --quick skips these) ---"
  for entry in "${SLOW[@]}"; do
    IFS='|' read -r name args what <<< "$entry"
    run_one "$name" "$args" "$what"
  done
fi

if [ $fail -eq 0 ]; then echo "all green"; else echo "SOMETHING IS RED"; fi
exit $fail
