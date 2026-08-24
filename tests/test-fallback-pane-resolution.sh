#!/usr/bin/env bash
# Test fallback pane resolution in agent-state.sh when TMUX_PANE is unset:
# env-scan candidate priority, then fall-through to the active pane.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "fallback"
create_other_window

# Invoke agent-state.sh without TMUX_PANE. run-shell forwards the invoking
# shell's TMUX_PANE into the job environment (which may collide with a pane
# id in this server), so unset it inside the command string.
run_without_tmux_pane() {
    local state="$1"
    tmux_cmd run-shell "unset TMUX_PANE; \"$ROOT_DIR/scripts/agent-state.sh\" --agent claude --state $state"
}

wait_for_env_value() {
    local key="$1" expected="$2"
    local value=""
    for _ in $(seq 1 30); do
        value="$(get_env "$key")"
        if [ "$value" = "$expected" ]; then
            return 0
        fi
        sleep 0.05
    done
    fail "$key expected '$expected', got '${value:-<empty>}'"
}

# Scenario A: env-scan candidate in running state receives the transition
# (running candidate wins over the current active pane).
tmux_cmd set-environment -g "TMUX_AGENT_PANE_${OTHER_PANE}_AGENT" "claude"
tmux_cmd set-environment -g "TMUX_AGENT_PANE_${OTHER_PANE}_STATE" "running"
run_without_tmux_pane "done"
wait_for_env_value "TMUX_AGENT_PANE_${OTHER_PANE}_STATE" "done"
assert_empty "$(get_env "TMUX_AGENT_PANE_${PANE}_STATE")" \
    "active pane state should stay empty when a scan candidate exists"

# Scenario B: no scan candidates and no active-pane map entry -> the
# transition falls through to the current active pane.
for key in "TMUX_AGENT_PANE_${OTHER_PANE}_AGENT" \
    "TMUX_AGENT_PANE_${OTHER_PANE}_STATE" \
    "TMUX_AGENT_PANE_${OTHER_PANE}_DONE" \
    "TMUX_AGENT_PANE_${OTHER_PANE}_DONE_WINDOW" \
    "TMUX_AGENT_PANE_${OTHER_PANE}_PENDING_RESET" \
    "TMUX_AGENT_ACTIVE_PANE_claude"; do
    tmux_cmd set-environment -gu "$key" 2>/dev/null || true
done
run_without_tmux_pane "done"
wait_for_env_value "TMUX_AGENT_PANE_${PANE}_STATE" "done"

# Scenario C (regression, tmux 3.2a): a dead pane candidate (its window
# killed, env keys left behind) must be skipped by the scan and the
# transition must fall through to the active pane. On tmux 3.2a,
# `display-message -p -t <dead-pane>` prints an empty id but exits 0,
# so the old exit-code-only pane_exists always returned true: the dead
# candidate won the scan, select-pane crashed, and state was written to
# the dead pane's keys instead of the live pane's.
tmux_cmd kill-window -t "$OTHER_WIN"
tmux_cmd set-environment -g "TMUX_AGENT_PANE_${OTHER_PANE}_AGENT" "claude"
tmux_cmd set-environment -g "TMUX_AGENT_PANE_${OTHER_PANE}_STATE" "running"
for key in "TMUX_AGENT_PANE_${PANE}_AGENT" \
    "TMUX_AGENT_PANE_${PANE}_STATE" \
    "TMUX_AGENT_PANE_${PANE}_DONE" \
    "TMUX_AGENT_PANE_${PANE}_DONE_WINDOW" \
    "TMUX_AGENT_PANE_${PANE}_PENDING_RESET" \
    "TMUX_AGENT_ACTIVE_PANE_claude"; do
    tmux_cmd set-environment -gu "$key" 2>/dev/null || true
done
run_without_tmux_pane "done"
wait_for_env_value "TMUX_AGENT_PANE_${PANE}_STATE" "done"
dead_state="$(get_env "TMUX_AGENT_PANE_${OTHER_PANE}_STATE")"
[ "$dead_state" = "running" ] || \
    fail "dead pane state key must stay 'running', got '${dead_state:-<empty>}'"

pass "fallback pane resolution picks running candidate first, then active pane"
