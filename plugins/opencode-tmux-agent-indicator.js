// tmux-agent-indicator plugin for OpenCode v2.
// Install to ~/.config/opencode/plugins/ (global) or .opencode/plugins/
// (project-level). Requires OpenCode v2: the plugin uses the V2 API
// (Plugin.define + ctx.event.subscribe); V1 plugin implementations do not
// run on V2. Tracks session state and calls agent-state.sh to update tmux
// pane visuals.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { dirname } from "node:path";

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
const DBG_LOG = "/tmp/opencode/tmux-plugin-debug.log";
const dbg = (msg) => { try { fs.appendFileSync(DBG_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {} };

export const setup = (ctx) => {
  dbg(`boot: subscribe=${typeof ctx?.event?.subscribe === "function"}`);
  const dir = process.env.TMUX_AGENT_INDICATOR_DIR
    || `${process.env.HOME}/.tmux/plugins/tmux-agent-indicator`;
  const script = `${dir}/scripts/agent-state.sh`;

  const lastStateByPane = new Map(); // paneId -> last state（按 pane 去重：多会话互不吞写）
  const idleAtBySession = new Map(); // sessionID -> 最近完成 ts（迟复守卫按会话隔离）
  const startedCount = new Map(); // sessionID -> execution.started 计数（在途执行判别）
  const succeededCount = new Map(); // sessionID -> execution.succeeded 计数

  // ---- session→pane 路由（2026-10-18 多目录多会话支持）----
  // session.location.directory ↔ pane cwd 匹配：每个 opencode pane 的状态只写
  // 自己的 pane（经 TMUX_PANE 优先通道），多目录并发会话互不串扰；顺带清理
  // 死 pane 的注册/状态键。
  // ---- sessionID→paneId 绑定持久化（抗插件实例重载）----
  // 实例 ~15-30min 周期重载清空内存 Map，重载后仅剩 directory 全等匹配，
  // session_move/目录删除场景永久失配（pane 卡死旧状态）。绑定写穿 JSON 文件
  // {pid, bindings}：写临时文件+rename（POSIX 原子，读者永不见半截文件）。
  // 多实例并发：读-合并-写，防断流 gap 内漏事件的陈旧实例整文件覆写抹掉他
  // 实例的新鲜绑定；残余——陈旧实例仍可能以旧值覆盖同键，paneAlive 失败即
  // 重绑，上界同持久化前行为。/tmp OS 重启即失可接受——要活过的是重载。
  // 文件带 tmux server pid：pane id 按 server 生命周期分配且复用，server 重启
  // 后「新 %1」可能是别家 pane 而 paneAlive 照样放行——pid 不匹配即全弃。
  const bindingsFile = process.env.TMUX_AGENT_INDICATOR_BINDINGS_FILE
    || "/tmp/opencode/tmux-agent-indicator-bindings.json";
  // server pid 实例生命周期内恒定；拿不到（无 tmux）＝不加载，落盘 stamp null
  // ＝下个实例照样弃（安全方向）。
  const serverPid = (() => {
    try { return execFileSync("tmux", ["display-message", "-p", "#{pid}"]).toString().trim() || null; }
    catch { return null; }
  })();
  const loadBindings = (pid) => {
    try {
      const raw = JSON.parse(fs.readFileSync(bindingsFile, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      if (!raw.pid || !pid || raw.pid !== pid) {
        if (raw.bindings && typeof raw.bindings === "object" && Object.keys(raw.bindings).length > 0) {
          dbg(`bindings ignored: server pid ${pid} != file pid ${raw.pid}`);
        }
        return [];
      }
      const b = raw.bindings;
      if (!b || typeof b !== "object" || Array.isArray(b)) return [];
      // 值必须是 tmux pane id 形（%N）：磁盘面在 /tmp，格式闸封死垃圾值下游。
      return Object.entries(b).filter(([k, v]) => k && typeof v === "string" && /^%\d+$/.test(v));
    } catch { return []; }
  };
  const persistBindings = (map, deletedKey) => {
    // 读-合并-写：以磁盘 pid 校验后的条目为底，并入本实例视图与显式删除项。
    try {
      fs.mkdirSync(dirname(bindingsFile), { recursive: true });
      const merged = new Map(loadBindings(serverPid));
      for (const [k, v] of map) merged.set(k, v);
      if (deletedKey !== undefined) merged.delete(deletedKey);
      // kill 于 write/rename 之间残留 *.tmp：微秒窗×数百字节，无清理亦无碍正确性。
      const tmp = `${bindingsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: serverPid, bindings: Object.fromEntries(merged) }));
      fs.renameSync(tmp, bindingsFile);
    } catch (error) { dbg(`persist bindings failed: ${error?.message ?? error}`); }
  };

  const sessionPane = new Map(); // sessionID -> pane_id
  // 重载恢复：setup 时把历史绑定灌回内存；fromDisk 记录来自文件的会话，其
  // 首次命中路由时 dbg 一条（生产验证钩子：确认持久化真的在救事件）。
  const fromDisk = new Set();
  for (const [k, v] of loadBindings(serverPid)) { sessionPane.set(k, v); fromDisk.add(k); }
  if (sessionPane.size > 0) dbg(`loaded ${sessionPane.size} bindings from ${bindingsFile}`);
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
    if (cached && (await paneAlive(cached))) {
      if (fromDisk.delete(sessionID)) dbg(`routed ${sessionID.slice(0, 12)} via persisted binding ${cached}`);
      return cached;
    }
    // 失效同步删除（显式 deletedKey，防合并时文件旧条目复活）：Map.delete 为
    // 真才写穿，避免无绑定事件反复重写文件。
    if (sessionPane.delete(sessionID)) persistBindings(sessionPane, sessionID);
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
      // 全等匹配：前缀匹配会把子目录里的外来子会话路由到祖先 pane。
      if (ppath === directory) { matched = paneId; break; }
    }
    if (matched) {
      sessionPane.set(sessionID, matched);
      fromDisk.delete(sessionID); // directory 匹配自愈的绑定不再是「来自文件」
      persistBindings(sessionPane);
    }
    return matched;
  };

  // Run agent-state.sh via execFile with an explicit args array and env
  // overlay — no shell interpolation, so titles and messages cannot break
  // quoting. Failures are non-fatal: tmux may not be available.
  const runAgentState = (state, extraEnv) => new Promise((resolve) => {
    execFile(
      "bash",
      [script, "--agent", "opencode", "--state", state],
      // stdio ignore：脚本内后台化的 notify 子进程会继承管道，execFile 须等
      // 管道全关才回调——60s 邮件防抖窗会把事件循环整个噎住（蓝延迟/丢失）
      { env: { ...process.env, ...extraEnv }, stdio: "ignore" },
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
    // 无法路由的会话（headless 委托子会话等）直接放弃：无 TMUX_PANE 的兜底
    // 会让 agent-state.sh 按全局 env 挑替补 pane，误翻别家（红→蓝串扰根因）。
    if (sessionID && !paneId) return;
    const paneEnv = paneId ? { TMUX_PANE: paneId } : {};
    if (paneId && lastStateByPane.get(paneId) === state) return;
    if (paneId) lastStateByPane.set(paneId, state);
    else if (!paneId && lastStateByPane.get("fallback") === state) return;
    lastStateByPane.set("fallback", state);
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

  const WATCHED = new Set(["session.instructions.updated", "session.execution.started", "session.execution.succeeded", "session.viewed", "session.error", "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled"]);
  const handleEvent = async (event) => {
    if (WATCHED.has(event?.type)) dbg(`evt ${event.type} sid=${String(event?.data?.sessionID ?? "-").slice(0, 12)}`);
    const data = event?.data;
    switch (event?.type) {
      // 2026-10-18 probe：session.status 全程零发射（死事件，V1 遗留），已移除。
      // 计数只认 execution.started（instructions 与之并存，双计会毒化配对判据）。
      case "session.execution.started": {
        if (data?.sessionID) {
          // 不变量：至多一个在途执行——被打断执行的孤儿计数在此自愈
          startedCount.set(data.sessionID, (succeededCount.get(data.sessionID) || 0) + 1);
          // 新回合开始的真信号不设 IDLE_GUARD（迟复误翻防护只属 replied 分支）
          await setState("running", { sessionID: data.sessionID });
        }
        break;
      }
      case "session.instructions.updated": {
        await setState("running", { sessionID: data?.sessionID || null });
        break;
      }

      // 2026-10-18 probe：session.idle 从不发射（死事件），回合完成真信号是
      // session.execution.succeeded（计数器配对防上一执行迟到回执）。
      case "session.execution.succeeded": {
        const sid = data?.sessionID;
        const sDone = (succeededCount.get(sid) || 0) + 1;
        succeededCount.set(sid, sDone);
        const sStarted = startedCount.get(sid) || 0;
        if (sDone < sStarted) {
          break;
        }
        idleAtBySession.set(sid, Date.now());
        await reportDone(data?.sessionID);
        break;
      }

      case "session.error": {
        idleAtBySession.set(data?.sessionID, Date.now());
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
        const sid = data?.sessionID || null;
        const lastIdle = sid ? (idleAtBySession.get(sid) || 0) : 0;
        if (Date.now() - lastIdle < IDLE_GUARD_MS) return;
        await setState("running", { sessionID: sid });
        break;
      }
    }
  };

  const controller = new AbortController();
  // 断流自愈：迭代器静默完结（服务端关闭/热重载竞态）→ 外层循环重订阅。
  // 2026-10-19 实测：基于墙钟的 stall 看门狗在系统休眠后被误判触发，且
  // abort 后的二次 subscribe 返回死流（同 server 上只订一次的探针全程健康）
  // ——看门狗比病毒，已移除。挂起型死流的代价：重启 server 恢复。
  void (async () => {
    let backoffMs = 1_000;
    for (;;) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          backoffMs = 1_000;
          await handleEvent(event);
        }
        dbg("event stream ended; resubscribing");
      } catch (error) {
        if (controller.signal.aborted) return;
        dbg(`event stream failed: ${error && error.message ? error.message : error}; resubscribing`);
      }
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
      if (controller.signal.aborted) return;
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
