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

if [ "${AGENT_STATE:-}" != "done" ]; then
    exit 0
fi

if ! command -v tmux >/dev/null 2>&1 || [ -z "${TMUX:-}" ]; then
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
delay="${delay:-10}"

agent="${AGENT_NAME:-opencode}"

pane_id=""
while IFS= read -r line; do
    [ -z "$line" ] && continue
    candidate="${line#TMUX_AGENT_PANE_}"
    candidate="${candidate%%_AGENT=*}"
    agent_val=$(tmux_get_env "TMUX_AGENT_PANE_${candidate}_AGENT")
    if [ "$agent_val" = "$agent" ]; then
        pane_id="$candidate"
        break
    fi
done < <(tmux show-environment -g 2>/dev/null | grep "^TMUX_AGENT_PANE_.*_AGENT=${agent}$" || true)

if [ -z "$pane_id" ]; then
    exit 0
fi

sleep "$delay"

state=$(tmux_get_env "TMUX_AGENT_PANE_${pane_id}_STATE")
if [ "$state" != "done" ]; then
    exit 0
fi

subject="[tmux-agent] ${agent} done in ${AGENT_SESSION:-unknown}"
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
        echo "Subject: ${subject}"
        echo "To: ${email_to}"
        echo ""
        echo "$body"
    } | sendmail "$email_to"
    exit 0
fi
