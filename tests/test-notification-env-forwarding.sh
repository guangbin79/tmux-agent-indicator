#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "notif-env"

# Capture files for two scenarios
CAPTURE_UNSET="/tmp/tmux-agent-indicator-${SOCK}-notif-env-unset-${RANDOM}.txt"
CAPTURE_SET="/tmp/tmux-agent-indicator-${SOCK}-notif-env-set-${RANDOM}.txt"
register_tmp_file "$CAPTURE_UNSET"
register_tmp_file "$CAPTURE_SET"

tmux_cmd set -g @agent-indicator-notification-enabled 'on'
tmux_cmd set -g @agent-indicator-notification-states 'needs-input,done'

# ---------------------------------------------------------------------------
# Scenario 1: env var NOT available to agent-state.sh
# Without the explicit forwarding line in notify_state_change(),
# OPENCODE_LAST_MESSAGE will not reach the notification command.
# ---------------------------------------------------------------------------
tmux_cmd set -g @agent-indicator-notification-command "env > '$CAPTURE_UNSET'"
tmux_cmd run-shell \
    "TMUX_PANE=$PANE \"$ROOT_DIR/scripts/agent-state.sh\" --agent opencode --state needs-input"

sleep 0.3

if ! grep -q '^OPENCODE_LAST_MESSAGE=$' "$CAPTURE_UNSET"; then
    fail "OPENCODE_LAST_MESSAGE not forwarded when unset"
fi

if ! grep -q '^AGENT_NAME=opencode$' "$CAPTURE_UNSET"; then
    fail "AGENT_NAME not forwarded"
fi

if ! grep -q '^AGENT_STATE=needs-input$' "$CAPTURE_UNSET"; then
    fail "AGENT_STATE not forwarded"
fi

# ---------------------------------------------------------------------------
# Scenario 2: non-empty env var passed in the run-shell command prefix
# Verifies the full happy-path value propagation through the pipeline.
# ---------------------------------------------------------------------------
tmux_cmd set -g @agent-indicator-notification-command "env > '$CAPTURE_SET'"
tmux_cmd run-shell \
    "OPENCODE_LAST_MESSAGE=test-message-content TMUX_PANE=$PANE \"$ROOT_DIR/scripts/agent-state.sh\" --agent opencode --state done"

sleep 0.3

if ! grep -q '^OPENCODE_LAST_MESSAGE=test-message-content$' "$CAPTURE_SET"; then
    fail "OPENCODE_LAST_MESSAGE=test-message-content not propagated to notification-command subshell"
fi

if ! grep -q '^AGENT_NAME=opencode$' "$CAPTURE_SET"; then
    fail "AGENT_NAME not forwarded (scenario 2)"
fi

if ! grep -q '^AGENT_STATE=done$' "$CAPTURE_SET"; then
    fail "AGENT_STATE not forwarded (scenario 2)"
fi

pass "notification-command receives OPENCODE_LAST_MESSAGE and standard env vars"
