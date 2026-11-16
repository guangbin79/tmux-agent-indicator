#!/usr/bin/env bash
# $VAR inside @agent-indicator-notification-command / @agent-indicator-email-command
# must expand at fire time: tmux >=3.4 show-option display-escapes values
# ($ -> \$), so the option getters must unescape before bash -c sees the
# command string, or the README-documented $AGENT_NAME/$SUBJECT usage sends
# literals.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "notif-dollar"

# Poll a capture file until the pattern lands: run-shell jobs and the done
# delay are async, so a fixed timer races the job spawn (ag-1380c5 pattern).
wait_for_capture() {
    local capture_file="$1" pattern="$2"
    local waited=0
    until grep -qF -- "$pattern" "$capture_file" 2>/dev/null \
          || [ "$waited" -ge 50 ]; do
        sleep 0.1
        waited=$((waited + 1))
    done
    grep -qF -- "$pattern" "$capture_file" 2>/dev/null
}

CAPTURE_STATE="/tmp/tmux-agent-indicator-${SOCK}-notif-dollar-state-${RANDOM}.txt"
CAPTURE_SUBJECT="/tmp/tmux-agent-indicator-${SOCK}-notif-dollar-subject-${RANDOM}.txt"
register_tmp_file "$CAPTURE_STATE"
register_tmp_file "$CAPTURE_SUBJECT"

tmux_cmd set -g @agent-indicator-notification-enabled 'on'
tmux_cmd set -g @agent-indicator-notification-states 'needs-input,done'

# ---------------------------------------------------------------------------
# Scenario A (agent-state.sh chain): the option value keeps its literal $ at
# set time (single-quoted), so only the runtime env forwarded by
# notify_state_change can expand it.
# ---------------------------------------------------------------------------
tmux_cmd set -g @agent-indicator-notification-command \
    'echo "$AGENT_NAME $AGENT_STATE" > '"$CAPTURE_STATE"

run_state needs-input opencode

if ! wait_for_capture "$CAPTURE_STATE" 'opencode needs-input'; then
    fail "notification-command \$AGENT_NAME/\$AGENT_STATE did not expand (got: $(cat "$CAPTURE_STATE" 2>/dev/null))"
fi
if grep -qF '$AGENT_NAME' "$CAPTURE_STATE"; then
    fail "notification-command output contains literal \$AGENT_NAME (show-option display escaping not undone)"
fi

# ---------------------------------------------------------------------------
# Scenario B (notify-email.sh email-command chain): notification-command
# points at notify-email.sh; email-command echoes the SUBJECT the email
# layer exports, proving the second getter unescapes too.
# ---------------------------------------------------------------------------
tmux_cmd set -g @agent-indicator-notification-command "\"$ROOT_DIR/scripts/notify-email.sh\""
tmux_cmd set -g @agent-indicator-email-to 'test@example.com'
tmux_cmd set -g @agent-indicator-email-delay '0'
tmux_cmd set -g @agent-indicator-email-command 'echo "$SUBJECT" > '"$CAPTURE_SUBJECT"

run_state 'done' opencode

if ! wait_for_capture "$CAPTURE_SUBJECT" '[oc-done]'; then
    fail "email-command \$SUBJECT did not expand (got: $(cat "$CAPTURE_SUBJECT" 2>/dev/null))"
fi
if grep -qF '$SUBJECT' "$CAPTURE_SUBJECT"; then
    fail "email-command output contains literal \$SUBJECT (show-option display escaping not undone)"
fi

# ---------------------------------------------------------------------------
# Version gate: unescape must engage only for tmux >=3.4. The probe block is
# extracted verbatim from each script and replayed with a faked tmux -V, so
# next-X.Y / X.Ya / dev-build forms stay pinned without old tmux binaries.
# ---------------------------------------------------------------------------
gate_value() {
    local script="$1" version="$2"
    bash -c "tmux() { printf 'tmux %s\n' '$version'; }
        $(sed -n '/^tmux_display_escapes=0$/,/^fi$/p' "$script")
        printf '%s' \"\$tmux_display_escapes\""
}

for f in "$ROOT_DIR/scripts/agent-state.sh" "$ROOT_DIR/scripts/notify-email.sh"; do
    for pair in '3.4:1' '3.5:1' 'next-3.5:1' '3.4a:1' '3.5c:1' '4.0:1' '3.10:1' \
                '3.3a:0' '3.2a:0' '2.9:0' '3:0' 'master:1'; do
        ver="${pair%:*}"
        want="${pair#*:}"
        got="$(gate_value "$f" "$ver")"
        if [ "$got" != "$want" ]; then
            fail "version gate in $(basename "$f") for tmux '$ver': want $want, got '$got'"
        fi
    done
done

pass "notification-command and email-command expand \$AGENT_NAME/\$AGENT_STATE/\$SUBJECT after unescape"
