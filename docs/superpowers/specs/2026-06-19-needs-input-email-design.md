# needs-input Email Notification Design

**Date:** 2026-06-19
**Status:** Approved
**Scope:** `scripts/notify-email.sh`, `README.md`

## Goal

Extend `notify-email.sh` so that an agent entering `needs-input` state fires an
**immediate, throttled** email — in addition to the existing `done` email
(60s stability window). Differentiate the two via subject prefix.

## Current Behavior (baseline)

`notify-email.sh` is wired as `@agent-indicator-notification-command`. It runs
once per state transition with env vars `AGENT_NAME`, `AGENT_STATE`,
`AGENT_SESSION`, `AGENT_WINDOW`, `AGENT_PANE`, plus `OPENCODE_SESSION_TITLE`
from the OpenCode plugin.

- Early-exit unless `AGENT_STATE=done` (line 19-21).
- `session_all_done`: every tracked pane in the session is `done`.
- Sets a per-session auth token, sleeps `@agent-indicator-email-delay` (default
  60s), re-checks `session_all_done` AND that its token is still the latest.
- Sends email with subject prefix `[tmux-agent]`.

The token mechanism (`TMUX_AGENT_SESSION_${session}_EMAIL_AUTH`) ensures only
the most recent completion in a stability window fires — concurrent or
back-to-back completions collapse to one email.

## Design

### Entry dispatch

Replace the `if AGENT_STATE != done then exit` guard with a dispatch on
`AGENT_STATE`:

```
AGENT_STATE=done         → done path (existing logic, new subject prefix)
AGENT_STATE=needs-input  → needs-input path (new)
anything else            → exit 0
```

### needs-input path

1. **Master toggle**: read `@agent-indicator-email-needs-input-enabled`
   (default `on`). If off, exit.
2. **email_to gate**: same as done — if `@agent-indicator-email-to` is empty,
   exit.
3. **Throttle check**:
   - Read `TMUX_AGENT_SESSION_${session}_EMAIL_NEEDS_INPUT_LAST` (unix ts).
   - If `now - last < @agent-indicator-email-needs-input-throttle` (default
     `30`), exit silently.
   - Otherwise write `last = now` and continue.
4. **Invalidate pending done**: overwrite the shared auth token
   `TMUX_AGENT_SESSION_${session}_EMAIL_AUTH` with a fresh value. Any pending
   done script currently in `sleep` will see its stored token mismatch on
   re-check and exit without sending.
5. **Send immediately** (no `sleep`). Subject/body per template below. Uses
   `@agent-indicator-email-command` if set, otherwise falls back to `mail` →
   `sendmail` (same as done).

### done path

Unchanged except subject prefix `[tmux-agent]` → `[oc-done]`. The token check
after sleep now also implicitly serves "needs-input invalidated me" — no code
change needed beyond what's already there.

### Subject / body templates

| State | Subject (with OPENCODE_SESSION_TITLE) | Subject (fallback) | Body |
|---|---|---|---|
| done | `[oc-done] ${oc_session}` | `[oc-done] session ${AGENT_SESSION} complete` | `Session ${AGENT_SESSION} complete: all agents done at <date>` |
| needs-input | `[oc-need_input] ${oc_session}` | `[oc-need_input] session ${AGENT_SESSION} needs input` | `Session ${AGENT_SESSION}: agent ${AGENT_NAME} needs input at <date>` |

Subjects are MIME UTF-8 Base64 encoded via the existing `subject_enc` pattern
(`=?UTF-8?B?...?=`).

### New tmux options

```tmux
set -g @agent-indicator-email-needs-input-enabled 'on'   # default on
set -g @agent-indicator-email-needs-input-throttle '30'  # default 30 (seconds)
```

Existing options reused unchanged:
`@agent-indicator-email-to`, `@agent-indicator-email-delay`,
`@agent-indicator-email-command`.

### Invariants / edge cases

1. `email_to` unset → both states exit.
2. needs-input in session where another agent is still running → still fires
   immediately (you can authorize one while another runs).
3. needs-input fires during done's `sleep` window → done's post-sleep token
   check fails, done exits silently. No completion email is "made up" later
   unless the state genuinely cycles back through done.
4. `session_all_done` semantics unchanged: a session with any non-done pane
   (including needs-input) does NOT qualify as complete.
5. Throttle window has no recorded last value (first needs-input in session)
   → fires immediately.
6. `AGENT_STATE=running` / `off` → exit early (script does not handle these).

### Files changed

- `scripts/notify-email.sh` — main logic (entry dispatch, needs-input branch,
  throttle, token invalidation, subject prefix).
- `README.md` — document new options and the subject-prefix change in the
  existing "Email notifications (session-complete)" section.

### Out of scope (YAGNI)

- No new `@agent-indicator-email-done-enabled` flag (done remains gated by
  `email_to` being set, matching current behavior).
- No enumeration of every needs-input agent in the session — body reports only
  the `${AGENT_NAME}` that triggered this event.
- No changes to `agent-state.sh`, OpenCode plugin, or any other script.
- No new dependencies on external tools.
