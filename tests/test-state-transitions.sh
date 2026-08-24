#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "state-transitions"

run_state running
sleep 0.5
run_state needs-input
sleep 0.5
needs_input_style="$(get_window_option "$WIN" "window-status-style")"
assert_non_empty "$needs_input_style" "needs-input should style the active window title"

run_state done
sleep 0.5
done_style="$(get_window_option "$WIN" "window-status-style")"
assert_non_empty "$done_style" "done should style the active window title"

run_state off
sleep 0.5

state_after="$(get_env "TMUX_AGENT_PANE_${PANE}_STATE")"
assert_empty "$state_after" "pane state should be cleared after off"

indicator_after="$(run_indicator_capture "$PANE")"
assert_empty "$indicator_after" "indicator should be empty after off"

pass "state transitions running -> needs-input -> done -> off"
