#!/usr/bin/env bash
# Dump all tmux-agent-indicator settings
set -euo pipefail

# Check tmux availability and active server context
if ! command -v tmux >/dev/null 2>&1; then
    exit 0
fi
if ! tmux display-message -p '#{session_name}' >/dev/null 2>&1; then
    exit 0
fi

options=(
    @agent-indicator-indicator-enabled
    @agent-indicator-background-enabled
    @agent-indicator-border-enabled
    @agent-indicator-reset-on-focus
    @agent-indicator-processes
    @agent-indicator-icons
    @agent-indicator-animation-enabled
    @agent-indicator-animation-speed
    @agent-indicator-notification-enabled
    @agent-indicator-notification-states
    @agent-indicator-notification-format
    @agent-indicator-notification-duration
    @agent-indicator-notification-command
    @agent-indicator-email-to
    @agent-indicator-email-delay
    @agent-indicator-email-command
    @agent-indicator-email-needs-input-enabled
    @agent-indicator-email-needs-input-throttle
    @agent-indicator-email-body-limit
    @agent-indicator-session-dots-active
    @agent-indicator-session-dots-inactive
    @agent-indicator-session-dots-attention
    @agent-indicator-session-dots-color
    @agent-indicator-session-dots-active-color
    @agent-indicator-session-dots-attention-color
    @agent-indicator-session-dots-attention-states
)

# shellcheck disable=SC1010  # 'done' here is a literal state name, not the keyword
for state in running needs-input done; do
    options+=(
        "@agent-indicator-${state}-enabled"
        "@agent-indicator-${state}-bg"
        "@agent-indicator-${state}-border"
        "@agent-indicator-${state}-window-title-bg"
        "@agent-indicator-${state}-window-title-fg"
    )
done

for opt in "${options[@]}"; do
    val=$(tmux show-option -gqv "$opt" 2>/dev/null)
    if [ -n "$val" ]; then
        printf '%-50s %s\n' "$opt" "$val"
    else
        printf '%-50s %s\n' "$opt" "(not set)"
    fi
done
