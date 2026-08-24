#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "notif-env"

# Capture files for two scenarios
CAPTURE_UNSET="/tmp/tmux-agent-indicator-${SOCK}-notif-env-unset-${RANDOM}.txt"
CAPTURE_SET="/tmp/tmux-agent-indicator-${SOCK}-notif-env-set-${RANDOM}.txt"
CAPTURE_DISPLAY_OFF="/tmp/tmux-agent-indicator-${SOCK}-notif-env-display-off-${RANDOM}.txt"
CAPTURE_DETAIL="/tmp/tmux-agent-indicator-${SOCK}-notif-env-detail-${RANDOM}.txt"
register_tmp_file "$CAPTURE_UNSET"
register_tmp_file "$CAPTURE_SET"
register_tmp_file "$CAPTURE_DISPLAY_OFF"
register_tmp_file "$CAPTURE_DETAIL"

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

# ---------------------------------------------------------------------------
# Scenario 3: notification-display 'off' must keep the notification-command
# (email) chain firing. The tmux popup itself cannot be asserted in a
# headless socket; the suppression lives in the display-message guard in
# notify_state_change(), so this pins the surviving ext_cmd path.
# ---------------------------------------------------------------------------
tmux_cmd set -g @agent-indicator-notification-display 'off'
tmux_cmd set -g @agent-indicator-notification-command "env > '$CAPTURE_DISPLAY_OFF'"
tmux_cmd run-shell \
    "TMUX_PANE=$PANE \"$ROOT_DIR/scripts/agent-state.sh\" --agent opencode --state needs-input"

sleep 0.3

if ! grep -q '^AGENT_NAME=opencode$' "$CAPTURE_DISPLAY_OFF"; then
    fail "AGENT_NAME not forwarded with notification-display off"
fi

if ! grep -q '^AGENT_STATE=needs-input$' "$CAPTURE_DISPLAY_OFF"; then
    fail "AGENT_STATE not forwarded with notification-display off"
fi

if ! grep -q '^OPENCODE_LAST_MESSAGE=$' "$CAPTURE_DISPLAY_OFF"; then
    fail "OPENCODE_LAST_MESSAGE not forwarded with notification-display off"
fi

# ---------------------------------------------------------------------------
# Scenario 4: OPENCODE_STATE_DETAIL NOT available to agent-state.sh
# Without the explicit forwarding line in notify_state_change(), the var
# never reaches the notification command; it must appear as empty instead.
# ---------------------------------------------------------------------------
tmux_cmd set -g @agent-indicator-notification-command "env > '$CAPTURE_DETAIL'"
tmux_cmd run-shell \
    "TMUX_PANE=$PANE \"$ROOT_DIR/scripts/agent-state.sh\" --agent opencode --state needs-input"

sleep 0.3

if ! grep -q '^OPENCODE_STATE_DETAIL=$' "$CAPTURE_DETAIL"; then
    fail "OPENCODE_STATE_DETAIL not forwarded when unset"
fi

# ---------------------------------------------------------------------------
# Scenario 5: OPENCODE_STATE_DETAIL set in the run-shell prefix. The value
# contains spaces and a glob character class, so it must be single-quoted
# inside the run-shell string: sh -c then parses the whole thing as one
# assignment instead of splitting 'git push' into a command word.
# ---------------------------------------------------------------------------
tmux_cmd run-shell \
    "OPENCODE_STATE_DETAIL='[bash] git push' TMUX_PANE=$PANE \"$ROOT_DIR/scripts/agent-state.sh\" --agent opencode --state done"

sleep 0.3

if ! grep -q '^OPENCODE_STATE_DETAIL=\[bash\] git push$' "$CAPTURE_DETAIL"; then
    fail "OPENCODE_STATE_DETAIL='[bash] git push' not propagated to notification-command subshell"
fi

# Restore defaults for later consumers of this server
tmux_cmd set -g @agent-indicator-notification-display 'on'

pass "notification-command fires with notification-display off (email chain intact)"
pass "notification-command receives OPENCODE_LAST_MESSAGE and standard env vars"
pass "notification-command receives OPENCODE_STATE_DETAIL (unset -> empty, set -> verbatim)"
