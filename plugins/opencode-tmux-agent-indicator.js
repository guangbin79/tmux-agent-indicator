// tmux-agent-indicator plugin for OpenCode.
// Install to ~/.config/opencode/plugins/ or .opencode/plugins/ (project-level).
// Tracks session state and calls agent-state.sh to update tmux pane visuals.

export const TmuxAgentIndicator = async ({ $, client }) => {
  const dir = process.env.TMUX_AGENT_INDICATOR_DIR
    || `${process.env.HOME}/.tmux/plugins/tmux-agent-indicator`;
  const script = `${dir}/scripts/agent-state.sh`;

  let lastState = "off";
  let idleAt = 0;
  let sessionTitle = "";
  let lastAssistantMessage = "";

  const resolveSessionTitle = async (sessionID) => {
    try {
      const res = await client.session.get({ path: { id: sessionID } });
      sessionTitle = res.data?.title || "";
    } catch {
      sessionTitle = "";
    }
  };

  // Hard cap on the message length forwarded through the shell command line,
  // to stay well below the kernel's ARG_MAX ceiling (~2MB on Linux). The
  // user-configured @agent-indicator-email-body-limit (default 2000) applies
  // downstream in notify-email.sh; this is a separate safety net.
  const PLUGIN_MESSAGE_CAP = 100000;

  const resolveLastAssistantMessage = async (sessionID) => {
    try {
      const res = await client.session.messages({
        path: { id: sessionID },
        query: { limit: 20 },
      });
      const messages = Array.isArray(res?.data) ? res.data : [];
      // Skip assistant messages that have no usable text part (e.g. tool-call-only turns).
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m?.info?.role === "assistant"
          && Array.isArray(m?.parts)
          && m.parts.some((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim() !== ""));
      const text = (lastAssistant?.parts || [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
      lastAssistantMessage = text.length > PLUGIN_MESSAGE_CAP
        ? `${text.slice(0, PLUGIN_MESSAGE_CAP)}...(truncated)`
        : text;
    } catch {
      lastAssistantMessage = "";
    }
  };

  const setState = async (state) => {
    if (state === lastState) return;
    lastState = state;
    try {
      if (state === "running") {
        await $`bash ${script} --agent opencode --state off`;
      }
      await $`OPENCODE_SESSION_TITLE=${sessionTitle} OPENCODE_LAST_MESSAGE=${lastAssistantMessage} bash ${script} --agent opencode --state ${state}`;
    } catch {
      // non-fatal: tmux may not be available
    }
  };

  return {
    event: async ({ event }) => {
      if (event.type === "session.status"
          && event.properties.status.type === "busy") {
        // Guard: don't override done/error if idle fired recently (race condition)
        if (Date.now() - idleAt < 2000) return;
        await setState("running");
      }

      if (event.type === "permission.updated"
          || event.type === "permission.asked") {
        await setState("needs-input");
      }

      if (event.type === "session.idle") {
        idleAt = Date.now();
        if (event.properties?.sessionID) {
          await resolveSessionTitle(event.properties.sessionID);
          await resolveLastAssistantMessage(event.properties.sessionID);
        }
        await setState("done");
      }

      if (event.type === "session.error") {
        idleAt = Date.now();
        if (event.properties?.sessionID) {
          await resolveSessionTitle(event.properties.sessionID);
          await resolveLastAssistantMessage(event.properties.sessionID);
        }
        await setState("done");
      }
    },
    "permission.ask": async () => {
      await setState("needs-input");
    },
    "tool.execute.before": async (input) => {
      if (input.tool === "question") {
        await setState("needs-input");
      }
    },
  };
};
