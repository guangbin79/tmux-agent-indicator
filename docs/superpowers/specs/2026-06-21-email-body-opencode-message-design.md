# Email body enhancement: include OpenCode last assistant message

**Date**: 2026-06-21
**Status**: Approved (pending spec review)
**Scope**: tmux-agent-indicator / email notifications

## Summary

Enhance the existing email notification (`scripts/notify-email.sh`) so that the email **body** for `done` and `needs-input` events includes the OpenCode agent's **last assistant message text**, replacing the current one-line summary. Non-OpenCode agents (Claude, Codex) are unaffected.

## Motivation

Current email bodies are minimal:

- `done`: `Session X complete: all agents done at <ts>`
- `needs-input`: `Session X: agent Y needs input at <ts>`

Users receiving these emails have no context about *what* the agent finished or *what* it is asking. Including the last assistant message makes the email self-sufficient — the user can act on it without opening the terminal.

## User-confirmed decisions

1. **Content source**: OpenCode session API only (last assistant message). No tmux pane capture for Claude/Codex.
2. **Content shape**: Only the last assistant message (no user prompt, no N-message window).
3. **Body handling**: **Replace** the current one-line summary with the assistant message (not append). Subject lines stay unchanged.
4. **Truncation**: Default 2000 characters, tail gets `...(truncated)`.

## Design

### Data flow

The existing pipeline already carries env vars from the OpenCode plugin through `agent-state.sh` into `notify-email.sh`. We add one new env var along the same path:

```
OpenCode plugin (opencode-tmux-agent-indicator.js)
  ├─ On session.idle / session.error / permission.ask / permission.asked /
  │   tool.execute.before(question) → switching to done | needs-input
  ├─ Fetch last assistant message via client.session.messages()
  └─ Export env: OPENCODE_LAST_MESSAGE="<text>" when calling agent-state.sh
       │
       ▼
agent-state.sh → notify_state_change() (lines 327-334)
  └─ Forward OPENCODE_LAST_MESSAGE="${OPENCODE_LAST_MESSAGE:-}" alongside
     AGENT_NAME/STATE/SESSION/WINDOW/PANE to the notification-command subshell
       │
       ▼
notify-email.sh
  └─ Read ${OPENCODE_LAST_MESSAGE:-}
  └─ If non-empty: body = "$OPENCODE_LAST_MESSAGE"
     If empty:     body = existing one-line summary (graceful fallback for
                   non-OpenCode agents or API failures)
```

**Why env var, not tmux global environment**: The message is tied to one specific state transition. Env vars die with the subshell, which prevents stale data leaking across panes or sessions. The `done` branch's 60-second `sleep` preserves env vars through the wait, so no persistence layer is needed.

### OpenCode API call

Confirmed API surface (verified against `~/.config/opencode/node_modules/@opencode-ai/sdk/`):

```js
const res = await client.session.messages({
  path: { id: sessionID },
  query: { limit: 20 },
});
// res.data: Array<{ info: Message, parts: Part[] }>
// Order: chronological (oldest first); last assistant is at the tail.
```

Filter and extract:

```js
const lastAssistant = [...(res.data || [])]
  .reverse()
  .find((m) => m?.info?.role === "assistant");
const text = (lastAssistant?.parts || [])
  .filter((p) => p?.type === "text" && typeof p.text === "string")
  .map((p) => p.text)
  .join("\n")
  .trim();
```

### Truncation

Default limit: 2000 characters. Configurable via tmux option:

```tmux
set -g @agent-indicator-email-body-limit '2000'
```

When the message exceeds the limit:

```
<first 2000 chars>...(truncated)
```

Implementation reads the limit inside `notify-email.sh` (bash substring + append marker). The OpenCode plugin does **not** truncate — it forwards the full message, so truncation behavior is centralized in one place and applies to any future content source.

### Fallback behavior

| Scenario | Body content |
|---|---|
| OpenCode, API returns last assistant message | The message text (truncated if needed) |
| OpenCode, API fails / throws | Existing one-line summary |
| OpenCode, session has no assistant messages yet | Existing one-line summary |
| OpenCode, message is empty string after extraction | Existing one-line summary |
| Claude / Codex (env var absent) | Existing one-line summary (unchanged) |

The fallback is the **existing summary line**, not an empty body. This guarantees we never regress the current UX.

## Changes

### 1. `plugins/opencode-tmux-agent-indicator.js`

Follows the existing `resolveSessionTitle` pattern (module-level variable + resolver function called before `setState`).

- Add module-level `let lastAssistantMessage = "";` alongside the existing `sessionTitle`.
- Add `resolveLastAssistantMessage(sessionID)` resolver mirroring `resolveSessionTitle`:
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
- Modify `setState`'s shell invocation to always forward `OPENCODE_LAST_MESSAGE` (empty string for `running` is harmless — fallback handles it):
  ```js
  await $`OPENCODE_SESSION_TITLE=${sessionTitle} OPENCODE_LAST_MESSAGE=${lastAssistantMessage} bash ${script} --agent opencode --state ${state}`;
  ```
  Bun's `$` shell tag auto-escapes interpolations, so multiline content and shell metacharacters in the message are safe.
- Call `resolveLastAssistantMessage(sessionID)` at the same call sites that already call `resolveSessionTitle(sessionID)` — specifically:
  - `session.idle` event handler (line 50-56)
  - `session.error` event handler (line 58-64)

  For events without a sessionID in properties (`permission.updated`, `permission.asked`, `permission.ask`, `tool.execute.before`), the existing code never calls `resolveSessionTitle` either. In those cases `lastAssistantMessage` retains its last-resolved value. This is acceptable because permission-driven `needs-input` transitions usually happen in the same session that previously resolved it. If no prior value exists, `lastAssistantMessage` is `""`, which triggers the fallback body.

### 2. `scripts/agent-state.sh`

Single change at `notify_state_change()` (lines 327-334): add `OPENCODE_LAST_MESSAGE="${OPENCODE_LAST_MESSAGE:-}"` to the env passed to the notification-command subshell. No other logic changes.

### 3. `scripts/notify-email.sh`

In both the `needs-input` and `done` branches, replace the current body construction:

```bash
# Pseudocode for both branches
body_limit=$(tmux_get_option "@agent-indicator-email-body-limit")
body_limit="${body_limit:-2000}"

if [ -n "${OPENCODE_LAST_MESSAGE:-}" ]; then
    body="$OPENCODE_LAST_MESSAGE"
    if [ "${#body}" -gt "$body_limit" ]; then
        body="${body:0:$body_limit}...(truncated)"
    fi
else
    body="<existing one-line summary>"  # current behavior preserved
fi
```

### 4. `README.md`

Under **Email notifications**, add a short paragraph:

> The email body includes the OpenCode agent's last assistant message when available (for `done` and `needs-input` events). For other agents (Claude, Codex), or if the message can't be retrieved, the body falls back to the standard one-line summary. Configure truncation via `@agent-indicator-email-body-limit` (default 2000 characters).

Document the new tmux option in the configuration reference block.

## Out of scope (YAGNI)

- ❌ Tmux pane capture for Claude/Codex
- ❌ Including user prompts alongside assistant responses
- ❌ Configurable N-message windows
- ❌ HTML or rich-text email formatting (plain text only)
- ❌ Subject line changes
- ❌ Changes to throttling, delay, or auth-token logic

## Testing

Per `docs/TESTING.md`, validate:

1. **OpenCode `done` path**: Trigger `session.idle` after an assistant response. Verify email body equals the assistant's text. Verify truncation when message exceeds 2000 chars.
2. **OpenCode `needs-input` path**: Trigger `permission.ask`. Verify email body equals the question the agent asked.
3. **API failure fallback**: Simulate `client.session.messages` throwing (e.g., invalid session ID). Verify email body falls back to the existing one-line summary, email still sends.
4. **Non-OpenCode agent**: Trigger Claude `Stop` hook. Verify `OPENCODE_LAST_MESSAGE` is unset and body is the existing one-line summary.
5. **Empty session**: Trigger transition before any assistant message exists. Verify fallback to summary.
6. **Configurable limit**: Set `@agent-indicator-email-body-limit 500`. Verify truncation at 500 chars.
7. **Existing behavior preserved**: Verify throttling, delay window, auth-token invalidation, and subject prefixes still work.

## Risks

- **API latency**: `client.session.messages` adds one async call before `agent-state.sh` fires. Mitigated by `try/catch` returning `""` on failure — the transition itself is never blocked.
- **Env var size**: Long messages pass through env. Bash handles multi-KB env vars fine; truncation caps at 2000 chars by default.
- **Multiline content**: Preserved as-is in plain-text email body.

## Open questions

None. All design questions resolved with the user.
