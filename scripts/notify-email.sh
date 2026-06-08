#!/usr/bin/env bash
# Email notification on agent done state.
# Configure via tmux options:
#   @agent-indicator-email-to      - recipient email (required)
#   @agent-indicator-email-delay   - seconds to wait before sending (default: 10)
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

email_to=$(tmux_get_option "@agent-indicator-email-to")
if [ -z "$email_to" ]; then
    exit 0
fi

delay=$(tmux_get_option "@agent-indicator-email-delay")
delay="${delay:-10}"

sleep "$delay"

if [ -n "$oc_session" ]; then
    subject="[tmux-agent] ${oc_session}"
else
    subject="[tmux-agent] ${agent} done in ${AGENT_SESSION:-unknown}"
fi
subject_enc="=?UTF-8?B?$(printf '%s' "$subject" | base64 -w0)?="
body="${agent} in ${AGENT_SESSION:-unknown}:${AGENT_WINDOW:-unknown} finished at $(date '+%Y-%m-%d %H:%M:%S')"

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
