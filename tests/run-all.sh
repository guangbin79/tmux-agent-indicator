#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

tests=(
    "$ROOT_DIR/tests/test-state-transitions.sh"
    "$ROOT_DIR/tests/test-indicator-output.sh"
    "$ROOT_DIR/tests/test-focus-reset-done.sh"
    "$ROOT_DIR/tests/test-email-body.sh"
    "$ROOT_DIR/tests/test-window-title-reset.sh"
    "$ROOT_DIR/tests/test-running-animation.sh"
    "$ROOT_DIR/tests/test-notification-env-forwarding.sh"
)

failed_tests=()

for test_script in "${tests[@]}"; do
    echo "==> $(basename "$test_script")"
    if ! "$test_script"; then
        failed_tests+=("$(basename "$test_script")")
    fi
done

if [ "${#failed_tests[@]}" -gt 0 ]; then
    echo "FAIL: ${#failed_tests[@]} test(s) failed:" >&2
    for name in "${failed_tests[@]}"; do
        echo "  - $name" >&2
    done
    exit 1
fi

echo "PASS: all automated tests"
