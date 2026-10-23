#!/usr/bin/env bash
# Shared helpers for isolated tmux-socket tests.

set -euo pipefail

TEST_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_LIB_DIR/../.." && pwd)"
# tmux resolves -L sockets under ${TMUX_TMPDIR:-/tmp}/tmux-$(id -u); tmux_cmd
# only strips TMUX, so an inherited TMUX_TMPDIR moves the socket dir.
TMUX_SOCKET_DIR="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"

SOCK=""
PANE=""
WIN=""
OTHER_PANE=""
OTHER_WIN=""
TEST_TMP_FILES=()

tmux_cmd() {
    env -u TMUX tmux -L "$SOCK" "$@"
}

register_tmp_file() {
    local path="$1"
    TEST_TMP_FILES+=("$path")
}

cleanup_test_server() {
    if [ -n "${SOCK:-}" ]; then
        tmux_cmd kill-server >/dev/null 2>&1 || true
        # kill-server normally unlinks the socket; rm is the fallback.
        rm -f "${TMUX_SOCKET_DIR}/${SOCK}" >/dev/null 2>&1 || true
    fi
    for path in "${TEST_TMP_FILES[@]:-}"; do
        rm -f "$path" >/dev/null 2>&1 || true
    done
    # register_tmp_file can't survive command substitution (subshell array);
    # sweep every tmp file this run created via the SOCK-name prefix instead.
    rm -f /tmp/tmux-agent-indicator-"${SOCK}"-* 2>/dev/null || true
}

# A driver shell may carry TMUX_AGENT_* keys (opencode serve snapshots its
# global env into descendants; gt-ef79/gt-2e1c). The test server copies the
# first client's env into its global env, which turns env-sensitive asserts
# red depending on driver lineage. Drop plugin keys server-side, once.
sanitize_inherited_env() {
    while IFS= read -r key; do
        tmux_cmd set-environment -gu "$key" >/dev/null 2>&1 || true
    done < <(tmux_cmd show-environment -g 2>/dev/null | grep -E '^TMUX_AGENT[^=]*=' | cut -d= -f1)
}

# Stale sockets from run-alls killed before their trap ran. Only touch the
# agent-test-* prefix, never the default socket; keep anything under 1h old
# so a concurrently running suite is not nuked. Run from setup_test_server,
# not at source time, so sourcing this lib has no side effects.
sweep_stale_test_sockets() {
    find "${TMUX_SOCKET_DIR}" -maxdepth 1 -name 'agent-test-*' -type s -mmin +60 -exec rm -f {} + 2>/dev/null || true
}

setup_test_server() {
    sweep_stale_test_sockets
    local name="${1:-test}"
    SOCK="agent-test-${name}-$$"

    tmux_cmd -f /dev/null new-session -d -s ai -n main
    sanitize_inherited_env
    tmux_cmd set -g status-right '#{agent_indicator} | %H:%M'
    tmux_cmd run-shell "$REPO_ROOT/agent-indicator.tmux"

    PANE="$(tmux_cmd display-message -p -t ai:main.0 '#{pane_id}')"
    WIN="$(tmux_cmd display-message -p -t ai:main.0 '#{window_id}')"
}

create_other_window() {
    tmux_cmd new-window -d -t ai -n other
    OTHER_PANE="$(tmux_cmd display-message -p -t ai:other.0 '#{pane_id}')"
    OTHER_WIN="$(tmux_cmd display-message -p -t ai:other.0 '#{window_id}')"
}

run_state() {
    local state="$1"
    local agent="${2:-claude}"
    tmux_cmd run-shell "TMUX_PANE=$PANE \"$REPO_ROOT/scripts/agent-state.sh\" --agent $agent --state $state"
}

get_env() {
    local key="$1"
    tmux_cmd show-environment -g "$key" 2>/dev/null | sed 's/^[^=]*=//' || true
}

get_window_option() {
    local window_id="$1"
    local option="$2"
    tmux_cmd show-window-option -v -t "$window_id" "$option" 2>/dev/null || true
}

run_indicator_capture() {
    local pane_id="${1:-$PANE}"
    local out_file="/tmp/tmux-agent-indicator-${SOCK}-${RANDOM}.out"
    register_tmp_file "$out_file"
    tmux_cmd run-shell "TMUX_PANE=$pane_id \"$REPO_ROOT/scripts/indicator.sh\" > \"$out_file\""
    sleep 0.05
    cat "$out_file" 2>/dev/null || true
}

wait_for_non_empty_env() {
    local key="$1"
    local attempts="${2:-20}"
    local delay="${3:-0.05}"
    local value=""

    for _ in $(seq 1 "$attempts"); do
        value="$(get_env "$key")"
        if [ -n "$value" ]; then
            printf '%s\n' "$value"
            return 0
        fi
        sleep "$delay"
    done
    return 1
}

fail() {
    echo "FAIL: $*"
    exit 1
}

pass() {
    echo "PASS: $*"
}

assert_non_empty() {
    local value="$1"
    local message="$2"
    [ -n "$value" ] || fail "$message"
}

assert_empty() {
    local value="$1"
    local message="$2"
    [ -z "$value" ] || fail "$message: $value"
}
