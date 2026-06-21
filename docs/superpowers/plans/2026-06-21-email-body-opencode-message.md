# Email Body: OpenCode Last Assistant Message — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the email body for `done`/`needs-input` events with the OpenCode agent's last assistant message when available, falling back to the existing one-line summary otherwise.

**Architecture:** End-to-end env-var pipeline. OpenCode plugin fetches the last assistant message via `client.session.messages()` and passes it as `OPENCODE_LAST_MESSAGE` through `agent-state.sh` into `notify-email.sh`, which replaces the body (with truncation) or falls back to the summary.

**Tech Stack:** Bash (scripts), JavaScript (OpenCode plugin runs on Bun), tmux test framework in `tests/lib/tmux-test-lib.sh`.

**Spec:** `docs/superpowers/specs/2026-06-21-email-body-opencode-message-design.md`

---

## File Structure

| File | Responsibility | Change Type |
|---|---|---|
| `scripts/agent-state.sh` | State machine + notification dispatch | Modify `notify_state_change()` (lines 327-334) to forward `OPENCODE_LAST_MESSAGE` env var to notification-command subshell |
| `scripts/notify-email.sh` | Email body construction + send | Modify `done` branch (line 149) and `needs-input` branch (line 118) to use `OPENCODE_LAST_MESSAGE` as body when non-empty; add truncation via `@agent-indicator-email-body-limit` option (default 2000) |
| `plugins/opencode-tmux-agent-indicator.js` | OpenCode → tmux bridge | Add module-level `lastAssistantMessage`, `resolveLastAssistantMessage(sessionID)` helper, call it at `session.idle`/`session.error`, forward env var in `setState` |
| `README.md` | Documentation | Add `@agent-indicator-email-body-limit` to config reference; add paragraph to Email notifications section about body content behavior |
| `tests/test-notification-env-forwarding.sh` | NEW automated test | Verify `OPENCODE_LAST_MESSAGE` reaches `notification-command` subshell |
| `tests/test-email-body.sh` | NEW automated test | Verify body replacement, fallback, and truncation in `notify-email.sh` |
| `tests/run-all.sh` | Test runner | Add the two new test scripts to the `tests` array |

**Boundary decisions:**
- Truncation lives in `notify-email.sh` (single source of truth for any future content source).
- `agent-state.sh` only forwards the env var — it does not interpret or transform content.
- Plugin always sets `OPENCODE_LAST_MESSAGE` (empty string when no data) — simplifies downstream logic.

---

## Task 1: Forward `OPENCODE_LAST_MESSAGE` through `agent-state.sh`

**Files:**
- Modify: `scripts/agent-state.sh:327-334`
- Create: `tests/test-notification-env-forwarding.sh`
- Modify: `tests/run-all.sh:7-13`

- [ ] **Step 1: Write the failing test**

Create `tests/test-notification-env-forwarding.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "notif-env"

# Capture file for notification-command output
CAPTURE_FILE="/tmp/tmux-agent-test-notif-env-${RANDOM}.txt"
register_tmp_file "$CAPTURE_FILE"

# Configure notification-command to dump its environment
tmux_cmd set -g @agent-indicator-notification-enabled 'on'
tmux_cmd set -g @agent-indicator-notification-states 'needs-input,done'
tmux_cmd set -g @agent-indicator-notification-command "env > '$CAPTURE_FILE'"

# Trigger needs-input state WITH the env var set
TMUX_PANE="$PANE" OPENCODE_LAST_MESSAGE="test-message-content" \
    "$ROOT_DIR/scripts/agent-state.sh" --agent opencode --state needs-input

# Notification runs in a background subshell; wait briefly
sleep 0.3

# Assert env var was forwarded
if ! grep -q '^OPENCODE_LAST_MESSAGE=test-message-content$' "$CAPTURE_FILE"; then
    fail "OPENCODE_LAST_MESSAGE not forwarded to notification-command subshell"
fi

# Assert standard env vars are still present (regression check)
if ! grep -q '^AGENT_NAME=opencode$' "$CAPTURE_FILE"; then
    fail "AGENT_NAME not forwarded"
fi
if ! grep -q '^AGENT_STATE=needs-input$' "$CAPTURE_FILE"; then
    fail "AGENT_STATE not forwarded"
fi

pass "notification-command receives OPENCODE_LAST_MESSAGE and standard env vars"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash tests/test-notification-env-forwarding.sh`
Expected: FAIL with `OPENCODE_LAST_MESSAGE not forwarded to notification-command subshell` (env var is not yet added to the dispatch).

- [ ] **Step 3: Implement the env var forwarding**

In `scripts/agent-state.sh`, locate `notify_state_change()` lines 327-334. Current code:

```bash
    local ext_cmd
    ext_cmd=$(tmux_get_option_or_default "@agent-indicator-notification-command" "")
    if [ -n "$ext_cmd" ]; then
        AGENT_NAME="$agent" AGENT_STATE="$state" \
        AGENT_SESSION="$session_name" AGENT_WINDOW="$window_name" \
        AGENT_PANE="$pane_id" \
        bash -c "$ext_cmd" 2>/dev/null &
    fi
```

Replace with:

```bash
    local ext_cmd
    ext_cmd=$(tmux_get_option_or_default "@agent-indicator-notification-command" "")
    if [ -n "$ext_cmd" ]; then
        AGENT_NAME="$agent" AGENT_STATE="$state" \
        AGENT_SESSION="$session_name" AGENT_WINDOW="$window_name" \
        AGENT_PANE="$pane_id" \
        OPENCODE_LAST_MESSAGE="${OPENCODE_LAST_MESSAGE:-}" \
        bash -c "$ext_cmd" 2>/dev/null &
    fi
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash tests/test-notification-env-forwarding.sh`
Expected: `PASS: notification-command receives OPENCODE_LAST_MESSAGE and standard env vars`

- [ ] **Step 5: Add the new test to the runner**

In `tests/run-all.sh`, modify the `tests` array to include the new test:

```bash
tests=(
    "$ROOT_DIR/tests/test-state-transitions.sh"
    "$ROOT_DIR/tests/test-indicator-output.sh"
    "$ROOT_DIR/tests/test-focus-reset-done.sh"
    "$ROOT_DIR/tests/test-window-title-reset.sh"
    "$ROOT_DIR/tests/test-running-animation.sh"
    "$ROOT_DIR/tests/test-notification-env-forwarding.sh"
)
```

- [ ] **Step 6: Run the full test suite to verify no regressions**

Run: `bash tests/run-all.sh`
Expected: All tests PASS, ending with `PASS: all automated tests`.

- [ ] **Step 7: Syntax check**

Run: `bash -n scripts/agent-state.sh tests/test-notification-env-forwarding.sh`
Expected: No output (clean syntax).

Run (if installed): `shellcheck scripts/agent-state.sh`
Expected: No new warnings introduced by the change.

- [ ] **Step 8: Commit**

```bash
git add scripts/agent-state.sh tests/test-notification-env-forwarding.sh tests/run-all.sh
git commit -m "Forward OPENCODE_LAST_MESSAGE to notification-command"
```

---

## Task 2: Replace email body with OpenCode message (with fallback + truncation)

**Files:**
- Modify: `scripts/notify-email.sh:83-156` (the `case "${AGENT_STATE:-}"` block)
- Create: `tests/test-email-body.sh`
- Modify: `tests/run-all.sh:7-13`

- [ ] **Step 1: Write the failing test**

Create `tests/test-email-body.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/tests/lib/tmux-test-lib.sh"

trap cleanup_test_server EXIT

setup_test_server "email-body"

# Helper: invoke notify-email.sh with env vars and capture body via email-command.
# Args: state, message_text (empty string for fallback test).
capture_email_body() {
    local state="$1"
    local message="$2"
    local capture_file="/tmp/tmux-agent-test-email-${RANDOM}.txt"
    register_tmp_file "$capture_file"

    tmux_cmd set -g @agent-indicator-email-to 'test@example.com'
    tmux_cmd set -g @agent-indicator-email-delay '0'
    tmux_cmd set -g @agent-indicator-email-needs-input-throttle '0'
    tmux_cmd set -g @agent-indicator-email-command "cat > '$capture_file'"

    # Mark the pane as done so session_all_done passes for done-state tests
    tmux_cmd set-environment -g "TMUX_AGENT_PANE_${PANE}_STATE" "done"

    OPENCODE_LAST_MESSAGE="$message" \
        AGENT_NAME="opencode" \
        AGENT_STATE="$state" \
        AGENT_SESSION="ai" \
        AGENT_WINDOW="main" \
        AGENT_PANE="$PANE" \
        bash "$ROOT_DIR/scripts/notify-email.sh"

    # done state sleeps email-delay seconds (set to 0 above) then sends
    sleep 0.3
    cat "$capture_file" 2>/dev/null || true
}

# Test 1: needs-input WITH message → body is the message (multiline-safe)
body="$(capture_email_body 'needs-input' 'agent needs database choice')"
if ! grep -q '^agent needs database choice$' <<< "$body"; then
    fail "needs-input body should contain OPENCODE_LAST_MESSAGE verbatim"
fi

# Test 2: needs-input WITHOUT message → body is the existing summary
body="$(capture_email_body 'needs-input' '')"
if ! grep -q 'agent opencode needs input' <<< "$body"; then
    fail "needs-input fallback body should contain summary line"
fi

# Test 3: done WITH message → body is the message
body="$(capture_email_body 'done' 'all tests passed, see diff')"
if ! grep -q '^all tests passed, see diff$' <<< "$body"; then
    fail "done body should contain OPENCODE_LAST_MESSAGE verbatim"
fi

# Test 4: done WITHOUT message → body is the existing summary
body="$(capture_email_body 'done' '')"
if ! grep -q 'Session ai complete' <<< "$body"; then
    fail "done fallback body should contain summary line"
fi

# Test 5: truncation at default 2000 chars
LONG_MESSAGE="$(printf 'a%.0s' {1..2500})"
body="$(capture_email_body 'needs-input' "$LONG_MESSAGE")"
body_len="${#body}"
if [ "$body_len" -le 2000 ]; then
    fail "truncated body should exceed 2000 chars (got $body_len) — truncation marker adds length"
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

pass "email body replacement, fallback, and truncation"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash tests/test-email-body.sh`
Expected: FAIL at Test 1 (`needs-input body should contain OPENCODE_LAST_MESSAGE verbatim`), because `notify-email.sh` currently writes only the hardcoded summary line.

- [ ] **Step 3: Add truncation helper function**

In `scripts/notify-email.sh`, after the existing `encode_subject()` function (around line 42), add:

```bash
truncate_body() {
    local text="$1"
    local limit="${2:-2000}"
    if [ "${#text}" -gt "$limit" ]; then
        printf '%s...(truncated)' "${text:0:$limit}"
    else
        printf '%s' "$text"
    fi
}
```

- [ ] **Step 4: Replace body construction in the `needs-input` branch**

In `scripts/notify-email.sh`, locate the `needs-input)` branch (currently lines 84-122). Find this block:

```bash
        subject_enc=$(encode_subject "$subject")
        body="Session ${AGENT_SESSION:-unknown}: agent ${agent} needs input at $(date '+%Y-%m-%d %H:%M:%S')"

        send_email "$email_to" "$subject" "$subject_enc" "$body" "$agent"
```

Replace with:

```bash
        subject_enc=$(encode_subject "$subject")
        body_limit=$(tmux_get_option "@agent-indicator-email-body-limit")
        body_limit="${body_limit:-2000}"
        if [ -n "${OPENCODE_LAST_MESSAGE:-}" ]; then
            body="$(truncate_body "$OPENCODE_LAST_MESSAGE" "$body_limit")"
        else
            body="Session ${AGENT_SESSION:-unknown}: agent ${agent} needs input at $(date '+%Y-%m-%d %H:%M:%S')"
        fi

        send_email "$email_to" "$subject" "$subject_enc" "$body" "$agent"
```

- [ ] **Step 5: Replace body construction in the `done` branch**

In `scripts/notify-email.sh`, locate the `done)` branch (currently lines 123-153). Find this block:

```bash
        subject_enc=$(encode_subject "$subject")
        body="Session ${AGENT_SESSION:-unknown} complete: all agents done at $(date '+%Y-%m-%d %H:%M:%S')"

        send_email "$email_to" "$subject" "$subject_enc" "$body" "$agent"
```

Replace with:

```bash
        subject_enc=$(encode_subject "$subject")
        body_limit=$(tmux_get_option "@agent-indicator-email-body-limit")
        body_limit="${body_limit:-2000}"
        if [ -n "${OPENCODE_LAST_MESSAGE:-}" ]; then
            body="$(truncate_body "$OPENCODE_LAST_MESSAGE" "$body_limit")"
        else
            body="Session ${AGENT_SESSION:-unknown} complete: all agents done at $(date '+%Y-%m-%d %H:%M:%S')"
        fi

        send_email "$email_to" "$subject" "$subject_enc" "$body" "$agent"
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bash tests/test-email-body.sh`
Expected: `PASS: email body replacement, fallback, and truncation`

- [ ] **Step 7: Add the new test to the runner**

In `tests/run-all.sh`, modify the `tests` array:

```bash
tests=(
    "$ROOT_DIR/tests/test-state-transitions.sh"
    "$ROOT_DIR/tests/test-indicator-output.sh"
    "$ROOT_DIR/tests/test-focus-reset-done.sh"
    "$ROOT_DIR/tests/test-window-title-reset.sh"
    "$ROOT_DIR/tests/test-running-animation.sh"
    "$ROOT_DIR/tests/test-notification-env-forwarding.sh"
    "$ROOT_DIR/tests/test-email-body.sh"
)
```

- [ ] **Step 8: Run the full test suite**

Run: `bash tests/run-all.sh`
Expected: All tests PASS.

- [ ] **Step 9: Syntax + lint check**

Run: `bash -n scripts/notify-email.sh tests/test-email-body.sh`
Expected: No output (clean syntax).

Run (if installed): `shellcheck scripts/notify-email.sh`
Expected: No new warnings.

- [ ] **Step 10: Commit**

```bash
git add scripts/notify-email.sh tests/test-email-body.sh tests/run-all.sh
git commit -m "Replace email body with OpenCode last assistant message"
```

---

## Task 3: OpenCode plugin fetches and forwards last assistant message

**Files:**
- Modify: `plugins/opencode-tmux-agent-indicator.js`

**Note on testing:** This plugin runs inside the OpenCode runtime — no automated unit test harness exists for it. The automated checks below are syntax-level. Manual integration test (Step 8) validates behavior end-to-end.

- [ ] **Step 1: Add module-level state variable**

In `plugins/opencode-tmux-agent-indicator.js`, locate lines 10-12:

```js
  let lastState = "off";
  let idleAt = 0;
  let sessionTitle = "";
```

Add one new variable:

```js
  let lastState = "off";
  let idleAt = 0;
  let sessionTitle = "";
  let lastAssistantMessage = "";
```

- [ ] **Step 2: Add `resolveLastAssistantMessage` helper**

Immediately after the existing `resolveSessionTitle` function (which ends at line 21 with `};`), insert:

```js
  const resolveLastAssistantMessage = async (sessionID) => {
    try {
      const res = await client.session.messages({
        path: { id: sessionID },
        query: { limit: 20 },
      });
      const messages = Array.isArray(res?.data) ? res.data : [];
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m?.info?.role === "assistant");
      lastAssistantMessage = (lastAssistant?.parts || [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
    } catch {
      lastAssistantMessage = "";
    }
  };
```

- [ ] **Step 3: Forward env var in `setState`**

In `plugins/opencode-tmux-agent-indicator.js`, locate the `setState` function. Current invocation (line 30):

```js
      await $`OPENCODE_SESSION_TITLE=${sessionTitle} bash ${script} --agent opencode --state ${state}`;
```

Replace with:

```js
      await $`OPENCODE_SESSION_TITLE=${sessionTitle} OPENCODE_LAST_MESSAGE=${lastAssistantMessage} bash ${script} --agent opencode --state ${state}`;
```

Bun's `$` shell tag auto-escapes interpolations, so multiline content and shell metacharacters are safe.

- [ ] **Step 4: Call `resolveLastAssistantMessage` at `session.idle`**

Locate the `session.idle` event handler (lines 50-56):

```js
      if (event.type === "session.idle") {
        idleAt = Date.now();
        if (event.properties?.sessionID) {
          await resolveSessionTitle(event.properties.sessionID);
        }
        await setState("done");
      }
```

Replace with:

```js
      if (event.type === "session.idle") {
        idleAt = Date.now();
        if (event.properties?.sessionID) {
          await resolveSessionTitle(event.properties.sessionID);
          await resolveLastAssistantMessage(event.properties.sessionID);
        }
        await setState("done");
      }
```

- [ ] **Step 5: Call `resolveLastAssistantMessage` at `session.error`**

Locate the `session.error` event handler (lines 58-64):

```js
      if (event.type === "session.error") {
        idleAt = Date.now();
        if (event.properties?.sessionID) {
          await resolveSessionTitle(event.properties.sessionID);
        }
        await setState("done");
      }
```

Replace with:

```js
      if (event.type === "session.error") {
        idleAt = Date.now();
        if (event.properties?.sessionID) {
          await resolveSessionTitle(event.properties.sessionID);
          await resolveLastAssistantMessage(event.properties.sessionID);
        }
        await setState("done");
      }
```

- [ ] **Step 6: Syntax check**

Run: `node --check plugins/opencode-tmux-agent-indicator.js`
Expected: No output (clean syntax).

- [ ] **Step 7: Manual install + integration test**

Install the modified plugin into the user's OpenCode config:

```bash
cp plugins/opencode-tmux-agent-indicator.js ~/.config/opencode/plugins/
```

Then follow the manual test procedure in `docs/TESTING.md` for email notifications, with attention to:

1. Run an OpenCode session that produces a final assistant message; trigger `session.idle`.
2. Verify the received email body equals the assistant's last text response.
3. Verify subject line is unchanged (`[oc-done] <session title>`).
4. Trigger a `permission.ask` event (e.g., agent requests approval).
5. Verify the received email body contains the agent's question text.
6. Verify throttling still works (multiple needs-input within 30s collapse).
7. Kill OpenCode mid-session to simulate API failure; verify fallback body (existing summary line).

- [ ] **Step 8: Commit**

```bash
git add plugins/opencode-tmux-agent-indicator.js
git commit -m "Fetch and forward OpenCode last assistant message"
```

---

## Task 4: Document the new option and behavior in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add paragraph to Email notifications section**

In `README.md`, locate the **Email notifications** section. Find the paragraph that begins with:

```
A bundled `scripts/notify-email.sh` emails you on two events:
```

After the existing description of the two events (the paragraph ends with `... the two never overlap confusingly.`), add a new paragraph immediately after:

```
The email body includes the OpenCode agent's last assistant message when available (for `done` and `needs-input` events). For other agents (Claude, Codex), or if the message cannot be retrieved, the body falls back to the standard one-line summary. Configure truncation via `@agent-indicator-email-body-limit` (default 2000 characters).
```

- [ ] **Step 2: Add config option to the reference block**

In `README.md`, locate the email notifications tmux option block:

```tmux
set -g @agent-indicator-notification-command 'bash ~/.tmux/plugins/tmux-agent-indicator/scripts/notify-email.sh'
set -g @agent-indicator-email-to 'you@example.com'                       # required
set -g @agent-indicator-email-delay '60'                                 # optional, session-complete stability window in seconds
set -g @agent-indicator-email-command ''                                 # optional, custom sender (body on stdin; falls back to `mail` / `sendmail`)
set -g @agent-indicator-email-needs-input-enabled 'on'                   # optional, enable needs-input emails (default: on)
set -g @agent-indicator-email-needs-input-throttle '30'                  # optional, needs-input throttle window in seconds (default: 30)
```

Add one new line at the end of this block:

```tmux
set -g @agent-indicator-email-body-limit '2000'                          # optional, max chars of OpenCode last assistant message in body (default: 2000)
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document email body content behavior and limit option"
```

---

## Final Verification

- [ ] **Run full test suite**

Run: `bash tests/run-all.sh`
Expected: All 7 test scripts PASS, ending with `PASS: all automated tests`.

- [ ] **Syntax check all changed shell scripts**

Run: `bash -n scripts/agent-state.sh scripts/notify-email.sh tests/test-notification-env-forwarding.sh tests/test-email-body.sh`
Expected: No output.

- [ ] **Syntax check plugin**

Run: `node --check plugins/opencode-tmux-agent-indicator.js`
Expected: No output.

- [ ] **Shellcheck (if installed)**

Run: `shellcheck scripts/agent-state.sh scripts/notify-email.sh`
Expected: No new warnings beyond any pre-existing ones.

- [ ] **Review the full diff**

Run: `git log --oneline main..HEAD` and `git diff main..HEAD`
Expected: 4 commits (one per task), diff matches the spec.
