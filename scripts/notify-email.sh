#!/usr/bin/env bash
# Email notification when a session becomes fully done.
# Fires once a session stays all-done (every tracked agent done) for the delay
# window with no agent state change in between.
# Configure via tmux options:
#   @agent-indicator-email-to      - recipient email (required)
#   @agent-indicator-email-delay   - stability window in seconds (default: 60)
#   @agent-indicator-email-command - custom send command, receives body on stdin
#
# Enable by setting in tmux.conf:
#   set -g @agent-indicator-notification-command 'bash ~/.tmux/plugins/tmux-agent-indicator/scripts/notify-email.sh'
#   set -g @agent-indicator-email-to 'you@example.com'

set -euo pipefail

agent="${AGENT_NAME:-opencode}"
oc_session="${OPENCODE_SESSION_TITLE:-}"

if [ "${AGENT_STATE:-}" != "done" ]; then
    exit 0
fi

tmux_get_option() {
    tmux show-option -gqv "$1" 2>/dev/null || true
}

tmux_get_env() {
    tmux show-environment -g "$1" 2>/dev/null | sed 's/^[^=]*=//' || true
}

email_to=$(tmux_get_option "@agent-indicator-email-to")
if [ -z "$email_to" ]; then
    exit 0
fi

delay=$(tmux_get_option "@agent-indicator-email-delay")
delay="${delay:-60}"

session="${AGENT_SESSION:-}"

session_all_done() {
    local panes p st found_done=0
    panes=$(tmux list-panes -t "$1" -F '#{pane_id}' 2>/dev/null || true)
    [ -z "$panes" ] && return 1
    while IFS= read -r p; do
        [ -z "$p" ] && continue
        st=$(tmux_get_env "TMUX_AGENT_PANE_${p}_STATE")
        [ -z "$st" ] && continue
        [ "$st" = "done" ] || return 1
        found_done=$((found_done + 1))
    done <<< "$panes"
    [ "$found_done" -gt 0 ]
}

[ -n "$session" ] || exit 0
session_all_done "$session" || exit 0

auth_key="TMUX_AGENT_SESSION_${session}_EMAIL_AUTH"
my_token="$$-$RANDOM"
tmux set-environment -g "$auth_key" "$my_token" 2>/dev/null || true

sleep "$delay"

session_all_done "$session" || exit 0
[ "$my_token" = "$(tmux_get_env "$auth_key")" ] || exit 0

if [ -n "$oc_session" ]; then
    subject="[tmux-agent] ${oc_session}"
else
    subject="[tmux-agent] session ${AGENT_SESSION:-unknown} complete"
fi
subject_enc="=?UTF-8?B?$(printf '%s' "$subject" | base64 -w0)?="
body="Session ${AGENT_SESSION:-unknown} complete: all agents done at $(date '+%Y-%m-%d %H:%M:%S')"

email_cmd=$(tmux_get_option "@agent-indicator-email-command")
if [ -n "$email_cmd" ]; then
    echo "$body" | EMAIL_TO="$email_to" SUBJECT="$subject" \
        AGENT="$agent" bash -c "$email_cmd"
    exit 0
fi

if command -v mail >/dev/null 2>&1; then
    echo "$body" | mail -s "$subject" "$email_to"
    exit 0
fi

if command -v sendmail >/dev/null 2>&1; then
    {
        echo "Subject: ${subject_enc}"
        echo "To: ${email_to}"
        echo "Content-Type: text/plain; charset=UTF-8"
        echo ""
        echo "$body"
    } | sendmail "$email_to"
    exit 0
fi
