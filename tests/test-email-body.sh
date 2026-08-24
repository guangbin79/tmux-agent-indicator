#!/usr/bin/env bash
# Test email body replacement with OPENCODE_LAST_MESSAGE.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "email-body"

# Helper: invoke notify-email.sh via tmux run-shell so bare tmux commands
# within the script target the test server, and capture body via email-command.
capture_email_body() {
    local state="$1"
    local message="$2"
    local detail="${3:-}"
    local capture_file="/tmp/tmux-agent-indicator-${SOCK}-email-${RANDOM}.txt"
    register_tmp_file "$capture_file"

    tmux_cmd set -g @agent-indicator-email-to 'test@example.com'
    tmux_cmd set -g @agent-indicator-email-delay '0'
    tmux_cmd set -g @agent-indicator-email-needs-input-throttle '0'
    tmux_cmd set -g @agent-indicator-email-command "cat > '$capture_file'"

    # Mark the pane as done so session_all_done passes for done-state tests
    tmux_cmd set-environment -g "TMUX_AGENT_PANE_${PANE}_STATE" "done"

    tmux_cmd run-shell \
        "OPENCODE_STATE_DETAIL='$detail' \
         OPENCODE_LAST_MESSAGE='$message' \
         AGENT_NAME='opencode' \
         AGENT_STATE='$state' \
         AGENT_SESSION='ai' \
         AGENT_WINDOW='main' \
         AGENT_PANE='$PANE' \
         \"$ROOT_DIR/scripts/notify-email.sh\""

    # done state may sleep email-delay seconds (set to 0 above) then sends
    sleep 0.3
    cat "$capture_file" 2>/dev/null || true
}

# Test 1: needs-input WITH message -> body is the message (multiline-safe)
body="$(capture_email_body 'needs-input' 'agent needs database choice')"
if ! grep -q '^agent needs database choice$' <<< "$body"; then
    fail "needs-input body should contain OPENCODE_LAST_MESSAGE verbatim"
fi

# Test 2: needs-input WITHOUT message -> body is the existing summary
body="$(capture_email_body 'needs-input' '')"
if ! grep -q 'agent opencode needs input' <<< "$body"; then
    fail "needs-input fallback body should contain summary line"
fi

# Test 3: done WITH message -> body is the message
body="$(capture_email_body 'done' 'all tests passed, see diff')"
if ! grep -q '^all tests passed, see diff$' <<< "$body"; then
    fail "done body should contain OPENCODE_LAST_MESSAGE verbatim"
fi

# Test 4: done WITHOUT message -> body is the existing summary
body="$(capture_email_body 'done' '')"
if ! grep -q 'Session ai complete' <<< "$body"; then
    fail "done fallback body should contain summary line"
fi

# Test 5: truncation at default 2000 chars
LONG_MESSAGE="$(printf 'a%.0s' {1..2500})"
body="$(capture_email_body 'needs-input' "$LONG_MESSAGE")"
body_len="${#body}"
if [ "$body_len" -le 2000 ]; then
    fail "truncated body should exceed 2000 chars (got $body_len) -- truncation marker adds length"
fi
if [ "$body_len" -gt 2030 ]; then
    fail "truncated body should be ~2000 chars + marker (got $body_len)"
fi
if ! grep -q '\.\.\.(truncated)$' <<< "$body"; then
    fail "truncated body should end with ...(truncated)"
fi

# Test 6: configurable limit via @agent-indicator-email-body-limit
tmux_cmd set -g @agent-indicator-email-body-limit '100'
SHORT_MESSAGE="$(printf 'b%.0s' {1..150})"
body="$(capture_email_body 'needs-input' "$SHORT_MESSAGE")"
if ! grep -q '\.\.\.(truncated)$' <<< "$body"; then
    fail "body should truncate at configured limit 100"
fi
tmux_cmd set -gu '@agent-indicator-email-body-limit'  # reset

# Test 7: garbage LAST env value falls back to 0 (treated as never-sent)
tmux_cmd set-environment -g "TMUX_AGENT_SESSION_ai_EMAIL_NEEDS_INPUT_LAST" "garbage"
body="$(capture_email_body 'needs-input' 'agent needs database choice')"
if ! grep -q '^agent needs database choice$' <<< "$body"; then
    fail "garbage LAST env should fall back to 0 and still send needs-input email"
fi
tmux_cmd set-environment -gu "TMUX_AGENT_SESSION_ai_EMAIL_NEEDS_INPUT_LAST"

# Test 8: garbage @agent-indicator-email-body-limit falls back to 2000
tmux_cmd set -g @agent-indicator-email-body-limit 'abc'
GARBAGE_LIMIT_MESSAGE="$(printf 'c%.0s' {1..2500})"
body="$(capture_email_body 'done' "$GARBAGE_LIMIT_MESSAGE")"
if ! grep -q '\.\.\.(truncated)$' <<< "$body"; then
    fail "garbage body-limit should fall back to default 2000 and still truncate"
fi
tmux_cmd set -gu '@agent-indicator-email-body-limit'  # reset

# Test 9 (T3a): needs-input detail + message -> detail line, blank line, message
body="$(capture_email_body 'needs-input' 'agent needs database choice' '[bash] git push')"
if [ "$body" != $'[bash] git push\n\nagent needs database choice' ]; then
    fail "needs-input body should be detail + blank line + message"
fi

# Test 10 (T3b): needs-input detail only -> body is exactly the detail
body="$(capture_email_body 'needs-input' '' '[bash] git push')"
if [ "$body" != '[bash] git push' ]; then
    fail "needs-input detail-only body should be exactly the detail line"
fi

# Test 11 (T3c): needs-input message only (explicit empty detail) -> body is the message
body="$(capture_email_body 'needs-input' 'agent needs database choice' '')"
if ! grep -q '^agent needs database choice$' <<< "$body"; then
    fail "needs-input message-only body should contain OPENCODE_LAST_MESSAGE verbatim"
fi

# Test 12 (T3d): multi-line detail preserved line-by-line through run-shell
body="$(capture_email_body 'needs-input' '' $'[question] A?\n[question] B?')"
if [ "$body" != $'[question] A?\n[question] B?' ]; then
    fail "multi-line detail should be preserved verbatim as body"
fi

# Test 13 (T3e): truncation applies to the combined detail + message string
T3E_MESSAGE="$(printf 'a%.0s' {1..2500})"
body="$(capture_email_body 'needs-input' "$T3E_MESSAGE" '[bash] x')"
body_len="${#body}"
if [ "$body_len" -ne 2014 ]; then
    fail "combined body should be exactly limit 2000 + 14-char marker (got $body_len)"
fi
if [ "${body:0:8}" != '[bash] x' ]; then
    fail "combined body should start with the detail line (truncation on combined string)"
fi
if ! grep -q '\.\.\.(truncated)$' <<< "$body"; then
    fail "combined body should end with ...(truncated)"
fi

# Test 14 (T3f): done with error detail -> detail line first, message after
body="$(capture_email_body 'done' 'cleanup finished' '[error] ApiError: boom')"
if [ "$body" != $'[error] ApiError: boom\n\ncleanup finished' ]; then
    fail "done error body should be detail + blank line + message"
fi

# T3g: done without detail keeps current behavior (covered by Tests 3/4 above).

pass "email body replacement, fallback, and truncation"
