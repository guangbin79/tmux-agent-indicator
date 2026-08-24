#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "focus-reset-done"

run_state done
sleep 0.5
done_style="$(get_window_option "$WIN" "window-status-style")"
assert_non_empty "$done_style" "done should style the active window title (deferred reset keeps it until focus)"
tmux_cmd run-shell "$ROOT_DIR/scripts/pane-focus-in.sh \"$PANE\" \"$WIN\""
sleep 0.3

status_style_after="$(get_window_option "$WIN" "window-status-style")"
current_style_after="$(get_window_option "$WIN" "window-status-current-style")"
state_after="$(get_env "TMUX_AGENT_PANE_${PANE}_STATE")"

assert_empty "$status_style_after" "window-status-style should reset after done focus-in"
assert_empty "$current_style_after" "window-status-current-style should reset after done focus-in"
assert_empty "$state_after" "done state env should reset after done focus-in"

pass "done focus reset clears styles and pane state"
