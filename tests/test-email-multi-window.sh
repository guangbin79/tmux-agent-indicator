#!/usr/bin/env bash
# Test session-complete email scans ALL windows of the session.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "email-mw"
create_other_window

# Helper: invoke notify-email.sh (done state, agent in the "other" window)
# and capture body via email-command. Echoes capture file content.
capture_done_email() {
    local capture_file="/tmp/tmux-agent-indicator-${SOCK}-email-${RANDOM}.txt"
    register_tmp_file "$capture_file"

    tmux_cmd set -g @agent-indicator-email-to 'test@example.com'
    tmux_cmd set -g @agent-indicator-email-delay '0'
    tmux_cmd set -g @agent-indicator-email-command "cat > '$capture_file'"

    tmux_cmd run-shell \
        "AGENT_NAME='opencode' \
         AGENT_STATE='done' \
         AGENT_SESSION='ai' \
         AGENT_WINDOW='other' \
         AGENT_PANE='$OTHER_PANE' \
         \"$ROOT_DIR/scripts/notify-email.sh\""

    # done state sleeps email-delay seconds (set to 0 above) then sends
    sleep 0.3
    cat "$capture_file" 2>/dev/null || true
}

# Scenario A: done agent in non-current window, main pane untracked
# -> session counts as fully done, email fires.
tmux_cmd set-environment -gu "TMUX_AGENT_PANE_${PANE}_STATE" 2>/dev/null || true
tmux_cmd set-environment -g "TMUX_AGENT_PANE_${OTHER_PANE}_STATE" "done"
body="$(capture_done_email)"
if ! grep -q 'Session ai complete' <<< "$body"; then
    fail "done agent in non-current window should satisfy session completion"
fi

# Scenario B: done agent in other window, running agent in main window
# -> session not fully done, no email.
tmux_cmd set-environment -g "TMUX_AGENT_PANE_${PANE}_STATE" "running"
body="$(capture_done_email)"
if grep -q 'Session ai complete' <<< "$body"; then
    fail "running agent in any window should suppress session-complete email"
fi

pass "session-complete email scans all windows of the session"
