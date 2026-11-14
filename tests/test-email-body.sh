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
    local title="${4:-}"
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
         OPENCODE_SESSION_TITLE='$title' \
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

# Test 15 (ag-6b081f): Chinese last message survives the chain byte-exact —
# the captured body must contain the UTF-8 bytes of 配置完成 (e9 85 8d ...),
# never the double-encoded mojibake form é…ç½®.
body="$(capture_email_body 'needs-input' '配置完成：静等终态。' '')"
if ! grep -qF "$(printf '\xe9\x85\x8d\xe7\xbd\xae\xe5\xae\x8c\xe6\x88\x90')" <<< "$body"; then
    fail "Chinese OPENCODE_LAST_MESSAGE bytes corrupted in chain (配置完成 must arrive as e9 85 8d e7 bd ae e5 ae 8c e6 88 90)"
fi
if grep -qF "$(printf '\xc3\xa9\xc2\x85\xc2\x8d\xc3\xa7\xc2\xbd\xc2\xae')" <<< "$body"; then
    fail "Chinese body shows double-encoded mojibake form (UTF-8 bytes of 配置 read as latin1 and re-encoded)"
fi

# Tests 16-19 (ag-6b081f): daemon headless session email DND — sessions whose
# title matches @agent-indicator-email-exclude-title-regex never send
# done/needs-input email.
dnd_capture() {
    capture_email_body "$1" '配置完成：静等终态。' '' "$2"
}

# Test 16: default regex excludes issue-agent router sessions (done).
body="$(dnd_capture 'done' 'issue-agent router <hxnativeapp>')"
if [ -n "$body" ]; then
    fail "excluded title must not send done email (got body: $body)"
fi

# Test 17: default regex also suppresses needs-input for excluded titles.
body="$(dnd_capture 'needs-input' 'issue-agent router <hxnativeapp>')"
if [ -n "$body" ]; then
    fail "excluded title must not send needs-input email (got body: $body)"
fi

# Test 18: non-matching titles still email (no overmatch).
body="$(dnd_capture 'done' 'ag-123: 正常任务收尾')"
if ! grep -qF '配置完成' <<< "$body"; then
    fail "non-excluded title must still send done email with Chinese body"
fi

# Test 19: user-extendable regex.
tmux_cmd set -g @agent-indicator-email-exclude-title-regex '^plaza-'
body="$(dnd_capture 'done' 'plaza-watchdog')"
if [ -n "$body" ]; then
    fail "custom exclude regex must suppress matching title"
fi
body="$(dnd_capture 'done' 'issue-agent router <hxnativeapp>')"
if ! grep -qF '配置完成' <<< "$body"; then
    fail "custom exclude regex replaces default (issue-agent no longer matches)"
fi

# Test 20: invalid regex fails open — email still sends (grep error != match).
tmux_cmd set -g @agent-indicator-email-exclude-title-regex '['
body="$(dnd_capture 'done' 'issue-agent router <hxnativeapp>')"
if ! grep -qF '配置完成' <<< "$body"; then
    fail "invalid exclude regex must not suppress email (fail open)"
fi

# Test 21: match-nothing pattern disables the filter.
tmux_cmd set -g @agent-indicator-email-exclude-title-regex '$^'
body="$(dnd_capture 'done' 'issue-agent router <hxnativeapp>')"
if ! grep -qF '配置完成' <<< "$body"; then
    fail "match-nothing regex '\$^' must disable exclusion"
fi
tmux_cmd set -gu '@agent-indicator-email-exclude-title-regex'

# Test 22 (ag-1380c5): sendmail fallback emits the full MIME header block —
# run notify-email.sh with a PATH that offers only a fake sendmail (no mail
# binary reachable), capture what sendmail receives, and assert all four
# spec headers (plus Content-Transfer-Encoding for the raw 8-bit body) so
# clients never guess latin1 (mojibake root cause).
sendmail_capture() {
    local state="$1"
    local message="$2"
    local capture_file="/tmp/tmux-agent-indicator-${SOCK}-sendmail-${RANDOM}.txt"
    local fake_bin="/tmp/tmux-agent-indicator-${SOCK}-sendbin-${RANDOM}"
    register_tmp_file "$capture_file"

    mkdir -p "$fake_bin"
    # cat must be linked too: the fake sendmail writes via cat, and any
    # missing binary in the isolated PATH kills the script (127) — tmux then
    # prints the job error into this function's stdout, faking a body.
    for cmd_name in bash tmux sed grep base64 date cat; do
        ln -s "$(command -v "$cmd_name")" "$fake_bin/$cmd_name"
    done
    printf '#!/usr/bin/env bash\ncat > "$SENDMAIL_CAPTURE"\n' > "$fake_bin/sendmail"
    chmod +x "$fake_bin/sendmail"

    # No email-command, no reachable mail: force the sendmail fallback branch.
    tmux_cmd set -gu '@agent-indicator-email-command'
    tmux_cmd set -g @agent-indicator-email-to 'fallback@example.com'
    tmux_cmd set -g @agent-indicator-email-needs-input-throttle '0'

    tmux_cmd run-shell \
        "PATH='$fake_bin' SENDMAIL_CAPTURE='$capture_file' \
         OPENCODE_LAST_MESSAGE='$message' \
         AGENT_NAME='opencode' \
         AGENT_STATE='$state' \
         AGENT_SESSION='ai' \
         \"$ROOT_DIR/scripts/notify-email.sh\""

    # Poll until the trailer line lands: run-shell jobs are async; deleting
    # fake_bin on a fixed timer can race the job spawn and 127 the script
    # mid-flight, and first-byte (non-empty) is not "capture complete".
    local waited=0
    until grep -qF -- "$message" "$capture_file" 2>/dev/null \
          || [ "$waited" -ge 50 ]; do
        sleep 0.1
        waited=$((waited + 1))
    done
    rm -rf "$fake_bin"
    cat "$capture_file" 2>/dev/null || true
}

body="$(sendmail_capture 'needs-input' 'sendmail fallback body')"
if [ -z "$body" ]; then
    fail "sendmail fallback should capture the message via fake sendmail"
fi
if ! grep -q '^Subject: ' <<< "$body"; then
    fail "sendmail fallback should keep the Subject header"
fi
if ! grep -q '^From: fallback@example.com$' <<< "$body"; then
    fail "sendmail fallback should carry From header (sender = email_to)"
fi
if ! grep -q '^To: fallback@example.com$' <<< "$body"; then
    fail "sendmail fallback should keep the To header"
fi
if ! grep -Eq '^Date: [A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9:]{8} [+-][0-9]{4}$' <<< "$body"; then
    fail "sendmail fallback should carry an RFC 2822 Date header (date -R): $(grep '^Date:' <<< "$body")"
fi
if ! grep -q '^MIME-Version: 1.0$' <<< "$body"; then
    fail "sendmail fallback should carry MIME-Version: 1.0"
fi
if ! grep -q '^Content-Type: text/plain; charset=UTF-8$' <<< "$body"; then
    fail "sendmail fallback should carry Content-Type: text/plain; charset=UTF-8"
fi
if ! grep -q '^Content-Transfer-Encoding: 8bit$' <<< "$body"; then
    fail "sendmail fallback should declare Content-Transfer-Encoding: 8bit for the raw UTF-8 body"
fi
if ! grep -q '^sendmail fallback body$' <<< "$body"; then
    fail "sendmail fallback body should arrive verbatim after the header block"
fi

pass "email body replacement, fallback, truncation, CJK/DND, and sendmail MIME fallback"
