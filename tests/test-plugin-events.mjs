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

// Returns an error string if hooks.event threw, else null.
const emit = async (payload) => {
  try {
    await hooks.event(payload);
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

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("PASS: all plugin event assertions");
