// tmux-agent-indicator plugin for OpenCode v2.
// Install to ~/.config/opencode/plugins/ (global) or .opencode/plugins/
// (project-level). Requires OpenCode v2: the plugin uses the V2 API
// (Plugin.define + ctx.event.subscribe); V1 plugin implementations do not
// run on V2. Tracks session state and calls agent-state.sh to update tmux
// pane visuals.

import { execFile } from "node:child_process";
import fs from "node:fs";

// 2026-10-18 诊断仪表：boot/事件流/完成命中三点落盘（排障后随上游移除）
const DBG = "/tmp/opencode/tmux-plugin-debug.log";
const dbg = (s) => { try { fs.appendFileSync(DBG, `${new Date().toISOString()} ${s}\n`); } catch {} };

// Resolve the V2 plugin helper when running inside OpenCode; fall back to an
// identity shim so the module also loads under plain Node (tests, syntax
// checks). The V2 loader only needs a default export of {id, setup}.
const pluginApi = await import("@opencode/plugin").catch(() => ({}));
const Plugin = pluginApi.Plugin ?? { define: (definition) => definition };

const PLUGIN_ID = "tmux-agent-indicator";

// Hard cap on any text forwarded through the child process environment, to
// stay well below the kernel's ARG_MAX ceiling (~2MB on Linux). The
// user-configured @agent-indicator-email-body-limit (default 2000) applies
// downstream in notify-email.sh; this is a separate safety net.
const PLUGIN_MESSAGE_CAP = 100000;

// Late-reply guard: permission/form replies arriving within this window after
// an idle event must not flip finished styling back to running (race between
// a trailing reply and session teardown).
const IDLE_GUARD_MS = 2000;

// Event handler body. Exported for the stub-driver test; the default export
// below is what the OpenCode V2 loader consumes.
export const setup = (ctx) => {
  dbg(`boot: has event.subscribe=${typeof ctx?.event?.subscribe === "function"} has session.get=${typeof ctx?.session?.get === "function"}`);
  const dir = process.env.TMUX_AGENT_INDICATOR_DIR
    || `${process.env.HOME}/.tmux/plugins/tmux-agent-indicator`;
  const script = `${dir}/scripts/agent-state.sh`;

  let lastState = "off";
  let idleAt = 0;
  const startedCount = new Map(); // sessionID -> execution.started 计数（在途执行判别）
  const succeededCount = new Map(); // sessionID -> execution.succeeded 计数

  // ---- session→pane 路由（2026-10-18 多目录多会话支持）----
  // session.location.directory ↔ pane cwd 匹配：每个 opencode pane 的状态只写
  // 自己的 pane（经 TMUX_PANE 优先通道），多目录并发会话互不串扰；顺带清理
  // 死 pane 的注册/状态键。
  const sessionPane = new Map(); // sessionID -> pane_id
  const listAgentPanes = () => new Promise((resolve) => {
    execFile("tmux", ["list-panes", "-a", "-F", "#{pane_id}|#{pane_current_command}|#{pane_current_path}"],
      (err, stdout) => resolve(err ? [] : String(stdout).split("\n").filter(Boolean)));
  });
  const paneAlive = (paneId) => new Promise((resolve) => {
    execFile("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"],
      (err, stdout) => resolve(!err && String(stdout).trim() === paneId));
  });
  const prunePaneKeys = (livePanes) => new Promise((resolve) => {
    execFile("tmux", ["show-environment", "-g"], (err, stdout) => {
      if (err) return resolve();
      const live = new Set(livePanes);
      const dead = String(stdout).split("\n")
        .map((l) => (l.match(/^TMUX_AGENT_PANE_(%[0-9]+)_(?:AGENT|STATE)=/) || [])[1])
        .filter((p) => p && !live.has(p));
      for (const p of dead) {
        execFile("tmux", ["set-environment", "-gu", `TMUX_AGENT_PANE_${p}_AGENT`], () => {});
        execFile("tmux", ["set-environment", "-gu", `TMUX_AGENT_PANE_${p}_STATE`], () => {});
      }
      resolve();
    });
  });
  const resolvePaneForSession = async (sessionID) => {
    if (!sessionID) return null;
    const cached = sessionPane.get(sessionID);
    if (cached && (await paneAlive(cached))) return cached;
    sessionPane.delete(sessionID);
    let directory = "";
    try {
      const session = await ctx.session.get({ sessionID });
      directory = session?.location?.directory || "";
    } catch { return null; }
    if (!directory) return null;
    const panes = await listAgentPanes();
    await prunePaneKeys(panes.map((l) => l.split("|")[0]));
    let matched = null;
    for (const line of panes) {
      const [paneId, cmd, ppath] = line.split("|");
      if (cmd !== "opencode") continue;
      if (ppath === directory || directory.startsWith(ppath === "/" ? "/" : ppath + "/")) { matched = paneId; break; }
    }
    if (matched) sessionPane.set(sessionID, matched);
    return matched;
  };

  // Run agent-state.sh via execFile with an explicit args array and env
  // overlay — no shell interpolation, so titles and messages cannot break
  // quoting. Failures are non-fatal: tmux may not be available.
  const runAgentState = (state, extraEnv) => new Promise((resolve) => {
    execFile(
      "bash",
      [script, "--agent", "opencode", "--state", state],
      { env: { ...process.env, ...extraEnv } },
      () => resolve(),
    );
  });

  // Resolvers read the V2 session API (ctx is the server client) and return
  // values for the caller to pass through setState — session context is never
  // stored on the module, so one event's details cannot leak into another.
  const resolveSessionTitle = async (sessionID) => {
    try {
      const session = await ctx.session.get({ sessionID });
      return typeof session?.title === "string" ? session.title : "";
    } catch {
      return "";
    }
  };

  const resolveLastAssistantMessage = async (sessionID) => {
    try {
      const messages = await ctx.session.context({ sessionID });
      const list = Array.isArray(messages) ? messages : [];
      // V2 messages are flat: {type: "assistant", content: [{type: "text",
      // text}, ...]}. Skip assistant turns without usable text (e.g.
      // tool-call-only turns) and keep scanning backwards.
      for (let i = list.length - 1; i >= 0; i--) {
        const message = list[i];
        if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
        const text = message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (text === "") continue;
        return text.length > PLUGIN_MESSAGE_CAP
          ? `${text.slice(0, PLUGIN_MESSAGE_CAP)}...(truncated)`
          : text;
      }
      return "";
    } catch {
      return "";
    }
  };

  const setState = async (state, { sessionID = "", sessionTitle = "", lastMessage = "", stateDetail = "" } = {}) => {
    const paneId = sessionID ? await resolvePaneForSession(sessionID) : null;
    const paneEnv = paneId ? { TMUX_PANE: paneId } : {};
    if (state === lastState) return;
    lastState = state;
    try {
      if (state === "running") {
        // Reset deferred done styling before re-entering running.
        await runAgentState("off", paneEnv);
      }
      await runAgentState(state, {
        ...paneEnv,
        OPENCODE_SESSION_TITLE: sessionTitle,
        OPENCODE_LAST_MESSAGE: lastMessage,
        OPENCODE_STATE_DETAIL: stateDetail,
      });
    } catch {
      // non-fatal: tmux may not be available
    }
  };

  const reportDone = async (sessionID, stateDetail = "") => {
    if (sessionID) {
      const [title, message] = await Promise.all([
        resolveSessionTitle(sessionID),
        resolveLastAssistantMessage(sessionID),
      ]);
      await setState("done", { sessionID, sessionTitle: title, lastMessage: message, stateDetail });
    } else {
      await setState("done", { stateDetail });
    }
  };

  const reportNeedsInput = async (sessionID, stateDetail) => {
    if (sessionID) {
      const [title, message] = await Promise.all([
        resolveSessionTitle(sessionID),
        resolveLastAssistantMessage(sessionID),
      ]);
      await setState("needs-input", { sessionID, sessionTitle: title, lastMessage: message, stateDetail });
    } else {
      await setState("needs-input", { stateDetail });
    }
  };

  // Detail builders turn event payloads into the OPENCODE_STATE_DETAIL
  // context line — pure functions, zero API calls, safe on any event shape.
  const capDetail = (detail) => (detail.length > PLUGIN_MESSAGE_CAP
    ? `${detail.slice(0, PLUGIN_MESSAGE_CAP)}...(truncated)`
    : detail);

  // V2 permission.asked: {action, resources: string[], message?, ...}.
  const buildPermissionDetail = (data) => {
    const action = data?.action;
    if (typeof action !== "string") return "";
    const resources = Array.isArray(data?.resources) ? data.resources : [];
    let detail = resources.length > 0 ? `[${action}] ${resources.join(", ")}` : `[${action}]`;
    const message = typeof data?.message === "string" ? data.message.trim() : "";
    if (message !== "") detail += `\n${message}`;
    return capDetail(detail);
  };

  // V2 replacement for question.asked: form.created carries
  // {form: {title?, fields: [{label?, key?, options?: [{label}]}]}} — one
  // [question] line per field, options only when present.
  const buildFormDetail = (data) => {
    const form = data?.form;
    if (!form) return "";
    const fields = Array.isArray(form.fields) ? form.fields : [];
    const lines = fields.map((field) => {
      const options = Array.isArray(field?.options) ? field.options : [];
      const labels = options
        .map((option) => option?.label)
        .filter((label) => typeof label === "string");
      const opts = labels.length > 0 ? ` (options: ${labels.join(", ")})` : "";
      const label = typeof field?.label === "string" && field.label.trim() !== ""
        ? field.label.trim()
        : String(field?.key ?? "");
      return `[question] ${label}${opts}`;
    });
    if (lines.length === 0 && typeof form.title === "string" && form.title.trim() !== "") {
      lines.push(`[question] ${form.title.trim()}`);
    }
    if (lines.length === 0) return "";
    return capDetail(lines.join("\n"));
  };

  // V2 session.error: error is a discriminated union keyed by `name` with the
  // message at the top level (e.g. {name: "UnknownError", message}).
  // `error.data.message` is checked as a defensive fallback.
  const buildErrorDetail = (data) => {
    const error = data?.error;
    if (!error) return "";
    if (typeof error === "string") return capDetail(`[error] ${error}`);
    const name = typeof error.name === "string" && error.name !== "" ? error.name : "Error";
    const message = typeof error.message === "string" && error.message.trim() !== ""
      ? error.message.trim()
      : (typeof error.data?.message === "string" ? error.data.message.trim() : "");
    return capDetail(message ? `[error] ${name}: ${message}` : `[error] ${name}`);
  };

  const handleEvent = async (event) => {
    const data = event?.data;
    switch (event?.type) {
      case "session.status": {
        const statusType = data?.status?.type;
        if (statusType === "busy") {
          // Guard: don't override done if idle fired recently (race condition)
          if (Date.now() - idleAt < IDLE_GUARD_MS) return;
          await setState("running");
        } else if (statusType === "idle") {
          idleAt = Date.now();
          await reportDone(data?.sessionID);
        }
        // "retry" keeps the current running state; nothing to do.
        break;
      }

      // 2026-10-18 probe：session.status 全程零发射（死事件），用户消息入账的
      // 真信号是 session.instructions.updated——回合开始（running 蓝）改由它驱动。
      // 2026-10-18 probe：session.status 全程零发射（死事件），用户消息入账的
      // 真信号是 session.instructions.updated——回合开始（running 蓝）改由它驱动。
      // session.execution.started（与 succeeded 对称的执行开始）同样驱动 running。
      // 2026-10-18 probe：session.status 全程零发射（死事件），用户消息入账的
      // 真信号是 session.instructions.updated——回合开始（running 蓝）改由它驱动。
      // session.execution.started（与 succeeded 对称的执行开始）同样驱动 running。
      // 计数只认 execution.started（instructions 与之并存，双计会毒化配对判据）。
      case "session.execution.started": {
        if (data?.sessionID) {
          startedCount.set(data.sessionID, (startedCount.get(data.sessionID) || 0) + 1);
        }
        if (Date.now() - idleAt < IDLE_GUARD_MS) return;
        await setState("running");
        break;
      }
      case "session.instructions.updated": {
        if (Date.now() - idleAt < IDLE_GUARD_MS) return;
        await setState("running");
        break;
      }

      // session.idle fires alongside status idle; setState dedupes.
      case "session.idle": {
        idleAt = Date.now();
        await reportDone(data?.sessionID);
        break;
      }

      // 2026-10-18 probe：session.idle/status 从不发射，回合完成真信号是
      // session.execution.succeeded。但它可能是上一执行的迟到回执（用户在响应
      // 流式输出期间发出新消息时，succeeded 晚于新 instructions 到达）——
      // 30 秒新指令窗口内的 succeeded 视为陈旧，忽略（防红蓝误翻；真实完成
      // 会在下个回合末自愈）。
      case "session.execution.succeeded": {
        const sid = data?.sessionID;
        const sDone = (succeededCount.get(sid) || 0) + 1;
        succeededCount.set(sid, sDone);
        const sStarted = startedCount.get(sid) || 0;
        if (sDone < sStarted) {
          dbg(`skip stale succeeded (${sDone}/${sStarted}) sessionID=${sid ?? "-"}`);
          break;
        }
        dbg(`HIT execution.succeeded sessionID=${sid ?? "-"}`);
        idleAt = Date.now();
        await reportDone(data?.sessionID);
        break;
      }

      case "session.error": {
        idleAt = Date.now();
        await reportDone(data?.sessionID, buildErrorDetail(data));
        break;
      }

      case "permission.asked": {
        await reportNeedsInput(data?.sessionID, buildPermissionDetail(data));
        break;
      }

      // V2 replaces question.asked with the form API.
      case "form.created": {
        await reportNeedsInput(data?.form?.sessionID, buildFormDetail(data));
        break;
      }

      // Replies (and form answers/cancellations) hand control back to the
      // agent; the idle guard protects a just-reached done state.
      case "permission.replied":
      case "form.replied":
      case "form.cancelled": {
        if (Date.now() - idleAt < IDLE_GUARD_MS) return;
        await setState("running");
        break;
      }
    }
  };

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await handleEvent(event);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      dbg(`STREAM FAILED: ${error && error.message ? error.message : error}`);
      console.error("[tmux-agent-indicator] event stream failed:", error);
    }
  })();

  // Cleanup: abort the subscription when the plugin unloads.
  return () => controller.abort();
};

// 2026-10-18 实证：本运行时（2.0.32）已验证可用的导出形态是 plain-object
// { id, setup }（review-loop-trigger 同款，注入全链 live 验证）；Plugin.define
// 包裹形态下事件订阅静默失效（done/running 均不触发）。
export default {
  id: PLUGIN_ID,
  setup,
};
