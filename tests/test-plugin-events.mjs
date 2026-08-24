// Stub-driver test for plugins/opencode-tmux-agent-indicator.js.
// Run with: node tests/test-plugin-events.mjs
// Injects a fake $ (tagged-template command capture) and a fake OpenCode
// client into the plugin, replays the real opencode v1.18.21 event sequence,
// and asserts the emitted agent-state.sh command stream. No tmux, no bun,
// no live opencode — fully deterministic.

import { TmuxAgentIndicator } from "../plugins/opencode-tmux-agent-indicator.js";

const commands = [];
const $ = async (strings, ...values) => {
  const cmd = strings.reduce((s, str, i) => s + str + (values[i] ?? ""), "");
  commands.push(cmd);
  return cmd;
};

const client = {
  session: {
    get: async () => ({ data: { title: "T" } }),
    messages: async () => ({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "agent says hi" }] },
      ],
    }),
  },
};

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failures.push(detail ? `${name} [${detail}]` : name);
};

const hooks = await TmuxAgentIndicator({ $, client });

// Returns an error string if hooks.event threw, else null. Second arg lets a
// test drive a separate plugin instance (default: the shared hooks above).
const emit = async (payload, h = hooks) => {
  try {
    await h.event(payload);
    return null;
  } catch (err) {
    return `threw: ${err && err.message}`;
  }
};

// 1. session.status busy -> off (running reset) then running
{
  const n = commands.length;
  const err = await emit({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } });
  const batch = commands.slice(n);
  const offIdx = batch.findIndex((c) => c.includes("--state off"));
  const runIdx = batch.findIndex((c) => c.includes("--state running"));
  check("session.status busy: no throw", err === null, err || "");
  check("session.status busy: --state off then --state running",
    offIdx !== -1 && runIdx !== -1 && offIdx < runIdx,
    JSON.stringify(batch));
}

// 2. permission.asked -> resolve session title + last assistant message via sessionID, then needs-input
{
  const n = commands.length;
  const err = await emit({ event: { type: "permission.asked", properties: { sessionID: "s1", permission: "bash" } } });
  const batch = commands.slice(n);
  check("permission.asked: no throw", err === null, err || "");
  check("permission.asked: exactly one command", batch.length === 1, JSON.stringify(batch));
  check("permission.asked: title + last message + needs-input",
    batch.length === 1
      && batch[0].includes("OPENCODE_SESSION_TITLE=T")
      && batch[0].includes("OPENCODE_LAST_MESSAGE=agent says hi")
      && batch[0].includes("--state needs-input"),
    JSON.stringify(batch));
}

// 3. permission.replied -> back to running (off then running)
// (Runs BEFORE any idle event: idleAt is still 0, so the late-reply guard
// added for follow-up #2 does not trip here.)
{
  const n = commands.length;
  const err = await emit({ event: { type: "permission.replied", properties: { sessionID: "s1" } } });
  const batch = commands.slice(n);
  check("permission.replied: no throw", err === null, err || "");
  check("permission.replied: --state off + --state running",
    batch.length === 2
      && batch[0].includes("--state off")
      && batch[1].includes("--state running"),
    JSON.stringify(batch));
}

// 4. session.status idle -> resolve title/message, then done
{
  const n = commands.length;
  const err = await emit({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } } });
  const batch = commands.slice(n);
  check("session.status idle: no throw", err === null, err || "");
  check("session.status idle: done with title + last message",
    batch.length === 1
      && batch[0].includes("--state done")
      && batch[0].includes("OPENCODE_SESSION_TITLE=T")
      && batch[0].includes("OPENCODE_LAST_MESSAGE=agent says hi"),
    JSON.stringify(batch));
}

// 5. deprecated session.idle fires alongside status idle -> deduped, no new command
{
  const n = commands.length;
  const err = await emit({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  check("session.idle after status idle: no throw", err === null, err || "");
  check("session.idle after status idle: no new command (dedup)", commands.length === n,
    JSON.stringify(commands.slice(n)));
}

// 6. malformed session.status (empty properties) -> must not throw
{
  const n = commands.length;
  const err = await emit({ event: { type: "session.status", properties: {} } });
  check("malformed session.status: no throw (optional chaining)", err === null, err || "");
  check("malformed session.status: no command", commands.length === n,
    JSON.stringify(commands.slice(n)));
}

// 7. cross-session race: concurrent handlers must each carry their own session's
// title/message into their own command — never shared module state.
//
// Timing rationale: sA's messages stub is slow (30ms) while its get is instant.
// That is the interleaving that breaks module-level state on the OLD code:
// handler A writes its title, parks on the slow messages call, handler B fully
// overwrites the module vars and emits, then A resumes, writes its message, and
// A's setState reads B's title. (If A's get were also slow, A would finish
// entirely after B and read its own values — the race would not reproduce.)
{
  const raceClient = {
    session: {
      get: async ({ path }) => ({ data: { title: `title-${path.id}` } }),
      messages: async ({ path }) => {
        if (path.id === "sA") await new Promise((r) => setTimeout(r, 30));
        return {
          data: [
            { info: { role: "assistant" }, parts: [{ type: "text", text: `msg-${path.id}` }] },
          ],
        };
      },
    },
  };
  const raceHooks = await TmuxAgentIndicator({ $, client: raceClient });
  const n = commands.length;
  const p1 = emit({ event: { type: "session.status", properties: { sessionID: "sA", status: { type: "idle" } } } }, raceHooks);
  const p2 = emit({ event: { type: "permission.asked", properties: { sessionID: "sB" } } }, raceHooks);
  await Promise.all([p1, p2]);
  const batch = commands.slice(n);
  const doneCmd = batch.find((c) => c.includes("--state done"));
  const askCmd = batch.find((c) => c.includes("--state needs-input"));
  check("interleave: both commands emitted", !!doneCmd && !!askCmd, JSON.stringify(batch));
  check("interleave: sA done carries sA title+message",
    !!doneCmd && doneCmd.includes("OPENCODE_SESSION_TITLE=title-sA") && doneCmd.includes("OPENCODE_LAST_MESSAGE=msg-sA"),
    JSON.stringify(batch));
  check("interleave: sB needs-input carries sB title+message",
    !!askCmd && askCmd.includes("OPENCODE_SESSION_TITLE=title-sB") && askCmd.includes("OPENCODE_LAST_MESSAGE=msg-sB"),
    JSON.stringify(batch));
}

// 8. late permission.replied within 2s of idle must NOT flip done back to running.
// Uses the shared hooks: tests 4/5 fired idle milliseconds ago, so idleAt is
// fresh and inside the 2000ms window — deterministic.
{
  const n = commands.length;
  const err = await emit({ event: { type: "permission.replied", properties: { sessionID: "s1" } } });
  check("late permission.replied: no throw", err === null, err || "");
  check("late permission.replied within 2s of idle: no new command", commands.length === n,
    JSON.stringify(commands.slice(n)));
}

// T1a-T1i: OPENCODE_STATE_DETAIL wiring. Each case drives its own plugin
// instance so setState's per-instance lastState dedup starts fresh ("off").
{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({ event: { type: "permission.asked", properties: { sessionID: "s1", permission: "bash", patterns: ["git push", "rm -rf node_modules"] } } });
  const batch = commands.slice(n);
  check("T1a permission.asked: detail + title + last message",
    batch.length === 1
      && batch[0].includes("OPENCODE_STATE_DETAIL=[bash] git push, rm -rf node_modules")
      && batch[0].includes("OPENCODE_SESSION_TITLE=T")
      && batch[0].includes("OPENCODE_LAST_MESSAGE=agent says hi")
      && batch[0].includes("--state needs-input"),
    JSON.stringify(batch));
}

{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({
    event: {
      type: "question.asked",
      properties: {
        sessionID: "s1",
        questions: [
          { question: "Deploy?", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
          { question: "Sure?" },
        ],
      },
    },
  });
  const batch = commands.slice(n);
  const cmd = batch[0] || "";
  const questionLines = (cmd.match(/\[question\]/g) || []).length;
  const optionsCount = (cmd.match(/ \(options:/g) || []).length;
  check("T1b question.asked: one line per question, options only when present",
    batch.length === 1
      && questionLines === 2
      && optionsCount === 1
      && cmd.includes("[question] Deploy? (options: A, B)")
      && cmd.includes("[question] Sure?")
      && cmd.includes("--state needs-input"),
    JSON.stringify(batch));
}

{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({ event: { type: "session.error", properties: { sessionID: "s1", error: { name: "ApiError", data: { message: "boom" } } } } });
  const batch = commands.slice(n);
  check("T1c session.error: done with [error] name: message detail",
    batch.length === 1
      && batch[0].includes("--state done")
      && batch[0].includes("OPENCODE_STATE_DETAIL=[error] ApiError: boom"),
    JSON.stringify(batch));
}

{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({ event: { type: "session.error", properties: { sessionID: "s1", error: { name: "NameOnly", data: {} } } } });
  const batch = commands.slice(n);
  check("T1d error without message: [error] name with no ': ' suffix",
    batch.length === 1 && /OPENCODE_STATE_DETAIL=\[error\] NameOnly( |$)/.test(batch[0]),
    JSON.stringify(batch));
}

{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({ event: { type: "session.error", properties: { sessionID: "s1" } } });
  const batch = commands.slice(n);
  check("T1e session.error without error field: empty detail",
    batch.length === 1 && /OPENCODE_STATE_DETAIL=( |$)/.test(batch[0]) && batch[0].includes("--state done"),
    JSON.stringify(batch));
}

{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({ event: { type: "session.error", properties: { error: { name: "E", data: { message: "m" } } } } });
  const batch = commands.slice(n);
  check("T1f session.error without sessionID: detail still forwarded",
    batch.length === 1
      && batch[0].includes("--state done")
      && batch[0].includes("OPENCODE_STATE_DETAIL=[error] E: m"),
    JSON.stringify(batch));
}

check("T1g removed context-less hooks",
  hooks["permission.ask"] === undefined && !("tool.execute.before" in hooks));

{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({ event: { type: "permission.asked", properties: { sessionID: "s1", permission: "bash", patterns: [] } } });
  const batch = commands.slice(n);
  check("T1h empty patterns: [bash] with no trailing space",
    batch.length === 1 && /OPENCODE_STATE_DETAIL=\[bash\] b/.test(batch[0]),
    JSON.stringify(batch));
}

{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({ event: { type: "permission.asked", properties: { sessionID: "s1", permission: "bash", patterns: ["x".repeat(100001)] } } });
  const batch = commands.slice(n);
  check("T1i over-cap detail: truncated marker",
    batch.length === 1 && batch[0].includes("...(truncated)"),
    JSON.stringify(batch.map((c) => `${c.slice(0, 60)}...len=${c.length}`)));
}

{
  const h = await TmuxAgentIndicator({ $, client });
  const n = commands.length;
  await h.event({ event: { type: "session.error", properties: { sessionID: "s1", error: "quota exceeded" } } });
  const batch = commands.slice(n);
  check("T1j string error payload: [error] <string>, not undefined",
    batch.length === 1
      && /OPENCODE_STATE_DETAIL=\[error\] quota exceeded( |$)/.test(batch[0])
      && !batch[0].includes("undefined")
      && batch[0].includes("--state done"),
    JSON.stringify(batch));
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("PASS: all plugin event assertions");
