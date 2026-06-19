#!/usr/bin/env bash
# Email notifications for agent state transitions.
# Fires on two events:
#   - done: when a session becomes fully done (every tracked agent done) and
#     stays done for the delay window (default 60s). Only the most recent
#     completion sends; concurrent or back-to-back completions collapse.
#   - needs-input: immediately when any agent enters needs-input, throttled
#     per-session (default 30s).
# Configure via tmux options:
#   @agent-indicator-email-to      - recipient email (required)
#   @agent-indicator-email-delay   - stability window in seconds (default: 60)
#   @agent-indicator-email-command - custom send command, receives body on stdin
#   @agent-indicator-email-needs-input-enabled  - on/off (default: on)
#   @agent-indicator-email-needs-input-throttle - seconds (default: 30)
#
# Enable by setting in tmux.conf:
#   set -g @agent-indicator-notification-command 'bash ~/.tmux/plugins/tmux-agent-indicator/scripts/notify-email.sh'
#   set -g @agent-indicator-email-to 'you@example.com'

set -euo pipefail

agent="${AGENT_NAME:-opencode}"
oc_session="${OPENCODE_SESSION_TITLE:-}"

tmux_get_option() {
    tmux show-option -gqv "$1" 2>/dev/null || true
}

tmux_get_env() {
    tmux show-environment -g "$1" 2>/dev/null | sed 's/^[^=]*=//' || true
}

is_enabled() {
    case "$1" in
        on|true|yes|1) return 0 ;;
        *) return 1 ;;
    esac
}

encode_subject() {
    printf '=?UTF-8?B?%s?=' "$(printf '%s' "$1" | base64 -w0)"
}

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

send_email() {
    local email_to="$1" subject="$2" subject_enc="$3" body="$4" agent="$5"
    local email_cmd
    email_cmd=$(tmux_get_option "@agent-indicator-email-command")
    if [ -n "$email_cmd" ]; then
        echo "$body" | EMAIL_TO="$email_to" SUBJECT="$subject" \
            AGENT="$agent" bash -c "$email_cmd"
        return 0
    fi
    if command -v mail >/dev/null 2>&1; then
        echo "$body" | mail -s "$subject" "$email_to"
        return 0
    fi
    if command -v sendmail >/dev/null 2>&1; then
        {
            echo "Subject: ${subject_enc}"
            echo "To: ${email_to}"
            echo "Content-Type: text/plain; charset=UTF-8"
            echo ""
            echo "$body"
        } | sendmail "$email_to"
        return 0
    fi
}

case "${AGENT_STATE:-}" in
    needs-input)
        ni_enabled=$(tmux_get_option "@agent-indicator-email-needs-input-enabled")
        ni_enabled="${ni_enabled:-on}"
        is_enabled "$ni_enabled" || exit 0

        email_to=$(tmux_get_option "@agent-indicator-email-to")
        [ -n "$email_to" ] || exit 0

        session="${AGENT_SESSION:-}"
        [ -n "$session" ] || exit 0

        # Throttle: at most one needs-input email per window per session.
        throttle=$(tmux_get_option "@agent-indicator-email-needs-input-throttle")
        throttle="${throttle:-30}"
        last_key="TMUX_AGENT_SESSION_${session}_EMAIL_NEEDS_INPUT_LAST"
        last=$(tmux_get_env "$last_key")
        last="${last:-0}"
        now=$(date +%s)
        if [ "$((now - last))" -lt "$throttle" ]; then
            exit 0
        fi
        tmux set-environment -g "$last_key" "$now" 2>/dev/null || true

        # Invalidate any in-flight done email: overwriting the shared auth
        # token makes a pending done script's post-sleep check fail.
        auth_key="TMUX_AGENT_SESSION_${session}_EMAIL_AUTH"
        tmux set-environment -g "$auth_key" "$$-$RANDOM" 2>/dev/null || true

        if [ -n "$oc_session" ]; then
            subject="[oc-need_input] ${oc_session}"
        else
            subject="[oc-need_input] session ${AGENT_SESSION:-unknown} needs input"
        fi
        subject_enc=$(encode_subject "$subject")
        body="Session ${AGENT_SESSION:-unknown}: agent ${agent} needs input at $(date '+%Y-%m-%d %H:%M:%S')"

        send_email "$email_to" "$subject" "$subject_enc" "$body" "$agent"
        exit 0
        ;;
    done)
        email_to=$(tmux_get_option "@agent-indicator-email-to")
        [ -n "$email_to" ] || exit 0

        delay=$(tmux_get_option "@agent-indicator-email-delay")
        delay="${delay:-60}"

        session="${AGENT_SESSION:-}"
        [ -n "$session" ] || exit 0
        session_all_done "$session" || exit 0

        auth_key="TMUX_AGENT_SESSION_${session}_EMAIL_AUTH"
        my_token="$$-$RANDOM"
        tmux set-environment -g "$auth_key" "$my_token" 2>/dev/null || true

        sleep "$delay"

        session_all_done "$session" || exit 0
        [ "$my_token" = "$(tmux_get_env "$auth_key")" ] || exit 0

        if [ -n "$oc_session" ]; then
            subject="[oc-done] ${oc_session}"
        else
            subject="[oc-done] session ${AGENT_SESSION:-unknown} complete"
        fi
        subject_enc=$(encode_subject "$subject")
        body="Session ${AGENT_SESSION:-unknown} complete: all agents done at $(date '+%Y-%m-%d %H:%M:%S')"

        send_email "$email_to" "$subject" "$subject_enc" "$body" "$agent"
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
