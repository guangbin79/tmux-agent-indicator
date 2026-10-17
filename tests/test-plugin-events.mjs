// Stub-driver test for plugins/opencode-tmux-agent-indicator.js (OpenCode v2).
// Run with: node tests/test-plugin-events.mjs
//
// Injects a fake V2 plugin context (manual event bus + V2-shaped session
// stubs) into setup(), replays the OpenCode v2 event sequence, and asserts
// the emitted agent-state.sh invocations. The plugin's execFile calls run a
// real fixture script that records its args + OPENCODE_* env to a capture
// file, so assertions cover args AND environment exactly as agent-state.sh
// would see them. No tmux, no live opencode — fully deterministic.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pluginModule from "../plugins/opencode-tmux-agent-indicator.js";
import { setup as pluginSetup } from "../plugins/opencode-tmux-agent-indicator.js";

const rootDir = join(import.meta.dirname, "..");
const fixtureDir = mkdtempSync(join(tmpdir(), "tmux-agent-indicator-test-"));
const fixtureScripts = join(fixtureDir, "scripts");
execFileSync("mkdir", ["-p", fixtureScripts]);
// Fixture agent-state.sh: record args + OPENCODE_* env as JSON lines.
writeFileSync(join(fixtureScripts, "agent-state.sh"), `#!/usr/bin/env bash
set -euo pipefail
python3 - "$@" <<'PY'
import json, os, sys
record = json.dumps({
    "args": sys.argv[1:],
    "env": {
        "OPENCODE_SESSION_TITLE": os.environ.get("OPENCODE_SESSION_TITLE"),
        "OPENCODE_LAST_MESSAGE": os.environ.get("OPENCODE_LAST_MESSAGE"),
        "OPENCODE_STATE_DETAIL": os.environ.get("OPENCODE_STATE_DETAIL"),
    },
})
with open(os.environ["TMUX_AGENT_INDICATOR_CAPTURE"], "a") as fh:
    fh.write(record + "\\n")
PY
`);
process.env.TMUX_AGENT_INDICATOR_DIR = fixtureDir;

const failures = [];
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
    if (!ok) failures.push(detail ? `${name} [${detail}]` : name);
};

// --- V2 event bus -----------------------------------------------------------
// The plugin consumes ctx.event.subscribe({signal}) strictly sequentially, so
// the bus tracks a processed counter: pump() resolves only after the plugin
// finished handling the event (including its awaited execFile children).
const makeBus = () => {
    const queue = [];
    const controller = new AbortController();
    let processed = 0;
    let wake = null;
    let notify = () => {
        const w = wake;
        wake = null;
        w?.();
    };
    const subscribe = ({ signal } = {}) => (async function* () {
        while (!signal?.aborted) {
            if (queue.length === 0) {
                await new Promise((resolve) => { wake = resolve; });
                continue;
            }
            yield queue.shift();
            processed += 1;
            notify();
        }
    })();
    return {
        controller,
        get processed() { return processed; },
        push(event) {
            if (controller.signal.aborted) return;
            queue.push(event);
            notify();
        },
        subscribe,
    };
};

// Fake V2 session domain. Overridable per instance.
const makeSessionStub = (overrides = {}) => ({
    get: overrides.get ?? (async ({ sessionID }) => ({ id: sessionID, title: "T" })),
    context: overrides.context ?? (async () => [
        { type: "user", content: [{ type: "text", text: "q" }] },
        { type: "assistant", content: [{ type: "text", text: "agent says hi" }] },
    ]),
});

let instanceSeq = 0;
// Builds a live plugin instance: fresh capture file, fake ctx, awaited pumps.
const makePlugin = (overrides = {}) => {
    const capture = join(fixtureDir, `capture-${instanceSeq++}.jsonl`);
    writeFileSync(capture, "");
    process.env.TMUX_AGENT_INDICATOR_CAPTURE = capture;
    const bus = makeBus();
    const cleanup = pluginSetup({
        session: makeSessionStub(overrides.session),
        event: { subscribe: bus.subscribe },
    });
    const lines = () => readFileSync(capture, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    // Pump one event and return ONLY the command lines it produced.
    const pump = async (type, data = {}) => {
        const beforeLines = lines().length;
        const before = bus.processed;
        bus.push({ type, data });
        const deadline = Date.now() + 2000;
        while (bus.processed <= before) {
            if (Date.now() > deadline) throw new Error(`pump timeout on ${type}`);
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        return lines().slice(beforeLines);
    };
    return { bus, cleanup, lines, pump, capture };
};

const argState = (line) => {
    const i = line.args.indexOf("--state");
    return i === -1 ? null : line.args[i + 1];
};
const states = (lines) => lines.map(argState);

// --- 0. V2 loader contract ---------------------------------------------------
check("default export: {id, setup} for the V2 loader",
    pluginModule && pluginModule.id === "tmux-agent-indicator"
    && typeof pluginModule.setup === "function"
    && pluginModule.setup === pluginSetup,
    JSON.stringify({ id: pluginModule?.id, hasSetup: typeof pluginModule?.setup }));

// --- shared main-instance sequence -------------------------------------------
{
    const p = makePlugin();

    // 1. session.status busy -> off (running reset) then running with empty
    //    OPENCODE_* env (empty value = skip property application downstream).
    let batch = await p.pump("session.status", { sessionID: "s1", status: { type: "busy" } });
    check("session.status busy: off then running",
        JSON.stringify(states(batch)) === JSON.stringify(["off", "running"]),
        JSON.stringify(batch));
    check("session.status busy: off has no OPENCODE_* env, running has empty values",
        batch.length === 2
        && batch[0].env.OPENCODE_SESSION_TITLE === null
        && batch[1].env.OPENCODE_SESSION_TITLE === ""
        && batch[1].env.OPENCODE_LAST_MESSAGE === ""
        && batch[1].env.OPENCODE_STATE_DETAIL === "",
        JSON.stringify(batch));

    // 2. permission.asked (V2: action/resources/message) -> title + last
    //    assistant message + detail line, then needs-input.
    batch = await p.pump("permission.asked", {
        sessionID: "s1",
        action: "bash",
        resources: ["git push", "ls"],
        message: "Allow push to origin?",
    });
    check("permission.asked: exactly one command", batch.length === 1, JSON.stringify(batch));
    check("permission.asked: title + last message + needs-input",
        batch.length === 1
        && batch[0].env.OPENCODE_SESSION_TITLE === "T"
        && batch[0].env.OPENCODE_LAST_MESSAGE === "agent says hi"
        && argState(batch[0]) === "needs-input",
        JSON.stringify(batch));
    check("permission.asked: V2 detail [action] resources + message line",
        batch.length === 1
        && batch[0].env.OPENCODE_STATE_DETAIL === "[bash] git push, ls\nAllow push to origin?",
        JSON.stringify(batch));

    // 3. permission.replied -> back to running (off then running). Runs before
    //    any idle event, so the late-reply guard does not trip.
    batch = await p.pump("permission.replied", { sessionID: "s1", requestID: "per_1", reply: "once" });
    check("permission.replied: off + running",
        JSON.stringify(states(batch)) === JSON.stringify(["off", "running"]),
        JSON.stringify(batch));

    // 4. form.created (V2 replacement for question.asked) -> needs-input with
    //    one [question] line per field, options only when present.
    batch = await p.pump("form.created", {
        form: {
            id: "frm_1",
            sessionID: "s1",
            title: "Deployment check",
            fields: [
                {
                    key: "deploy",
                    label: "Deploy now?",
                    options: [{ label: "A", description: "x" }, { label: "B", description: "y" }],
                },
                { key: "sure", label: "Sure?" },
            ],
        },
    });
    const formDetail = batch[0]?.env.OPENCODE_STATE_DETAIL ?? "";
    check("form.created: needs-input with per-field question lines",
        batch.length === 1
        && argState(batch[0]) === "needs-input"
        && (formDetail.match(/\[question\]/g) || []).length === 2
        && formDetail.includes("[question] Deploy now? (options: A, B)")
        && formDetail.includes("[question] Sure?"),
        JSON.stringify(batch));

    // 5. form.replied -> running again (V2 has explicit reply events).
    batch = await p.pump("form.replied", { id: "frm_1", sessionID: "s1", answer: { deploy: "A" } });
    check("form.replied: off + running",
        JSON.stringify(states(batch)) === JSON.stringify(["off", "running"]),
        JSON.stringify(batch));

    // 6. form.created without fields falls back to the form title.
    batch = await p.pump("form.created", { form: { id: "frm_2", sessionID: "s1", title: "Pick one" } });
    check("form.created without fields: [question] <title>",
        batch.length === 1 && batch[0].env.OPENCODE_STATE_DETAIL === "[question] Pick one",
        JSON.stringify(batch));

    // 7. form.cancelled -> running (before any idle: guard inactive).
    batch = await p.pump("form.cancelled", { id: "frm_2", sessionID: "s1" });
    check("form.cancelled: off + running",
        JSON.stringify(states(batch)) === JSON.stringify(["off", "running"]),
        JSON.stringify(batch));

    // 8. session.status idle -> resolve title/message, then done.
    batch = await p.pump("session.status", { sessionID: "s1", status: { type: "idle" } });
    check("session.status idle: done with title + last message",
        batch.length === 1
        && argState(batch[0]) === "done"
        && batch[0].env.OPENCODE_SESSION_TITLE === "T"
        && batch[0].env.OPENCODE_LAST_MESSAGE === "agent says hi",
        JSON.stringify(batch));

    // 9. session.idle firing alongside status idle -> deduped, no new command.
    batch = await p.pump("session.idle", { sessionID: "s1" });
    check("session.idle after status idle: no new command (dedup)", batch.length === 0,
        JSON.stringify(batch));

    // 10. malformed session.status (no data) -> must not throw, no command.
    batch = await p.pump("session.status", {});
    check("malformed session.status: no throw, no command", batch.length === 0,
        JSON.stringify(batch));

    // 11. late replies within 2s of idle must NOT flip done back to running.
    //     Idle fired milliseconds ago (step 8), so the guard is active.
    const beforeLate = p.lines().length;
    await p.pump("permission.replied", { sessionID: "s1", requestID: "per_2", reply: "always" });
    await p.pump("form.replied", { id: "frm_2", sessionID: "s1", answer: {} });
    await p.pump("form.cancelled", { id: "frm_2", sessionID: "s1" });
    check("late replies within 2s of idle: no new command", p.lines().length === beforeLate,
        JSON.stringify(p.lines().slice(beforeLate)));

    // 12. cleanup aborts the subscription: later events are dropped.
    p.cleanup();
    const beforeCleanup = p.lines().length;
    p.bus.push({ type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("cleanup: events after abort are ignored", p.lines().length === beforeCleanup,
        JSON.stringify(p.lines().slice(beforeCleanup)));
}

// --- fresh-instance detail and resilience cases ------------------------------
{
    // Empty resources: "[bash]" with no trailing space.
    const p = makePlugin();
    await p.pump("permission.asked", { sessionID: "s1", action: "bash", resources: [] });
    const batch = p.lines();
    check("permission.asked empty resources: [bash] no trailing space",
        batch.length === 1 && batch[0].env.OPENCODE_STATE_DETAIL === "[bash]",
        JSON.stringify(batch));
}

{
    // Over-cap detail: truncated marker.
    const p = makePlugin();
    await p.pump("permission.asked", {
        sessionID: "s1",
        action: "bash",
        resources: ["x".repeat(100001)],
    });
    const batch = p.lines();
    check("over-cap detail: truncated marker",
        batch.length === 1 && batch[0].env.OPENCODE_STATE_DETAIL.includes("...(truncated)"),
        JSON.stringify(batch.map((l) => `${argState(l)} detail.len=${(l.env.OPENCODE_STATE_DETAIL ?? "").length}`)));
}

{
    // session.error (V2 discriminated union: name + top-level message).
    const p = makePlugin();
    await p.pump("session.error", {
        sessionID: "s1",
        error: { name: "UnknownError", message: "boom" },
    });
    const batch = p.lines();
    check("session.error: [error] name: message (top-level message)",
        batch.length === 1
        && argState(batch[0]) === "done"
        && batch[0].env.OPENCODE_STATE_DETAIL === "[error] UnknownError: boom",
        JSON.stringify(batch));
}

{
    // session.error without message: [error] name with no ": " suffix.
    const p = makePlugin();
    await p.pump("session.error", { sessionID: "s1", error: { name: "AbortedError" } });
    const batch = p.lines();
    check("session.error without message: [error] name only",
        batch.length === 1 && batch[0].env.OPENCODE_STATE_DETAIL === "[error] AbortedError",
        JSON.stringify(batch));
}

{
    // Legacy-shaped {name, data:{message}} still renders via the fallback.
    const p = makePlugin();
    await p.pump("session.error", {
        sessionID: "s1",
        error: { name: "ApiError", data: { message: "quota" } },
    });
    const batch = p.lines();
    check("session.error legacy data.message fallback: [error] ApiError: quota",
        batch.length === 1 && batch[0].env.OPENCODE_STATE_DETAIL === "[error] ApiError: quota",
        JSON.stringify(batch));
}

{
    // String error payload: [error] <string> on a fresh instance.
    const p = makePlugin();
    const first = await p.pump("session.error", { sessionID: "s1", error: "quota exceeded" });
    check("session.error string payload: [error] <string>",
        first.length === 1 && first[0].env.OPENCODE_STATE_DETAIL === "[error] quota exceeded",
        JSON.stringify(first));
}

{
    // Missing error field: empty detail on a fresh instance (the preceding
    // error case is separate because session.error arms the late-reply guard,
    // which would suppress the intermediate busy event by design).
    const p = makePlugin();
    await p.pump("session.status", { sessionID: "s1", status: { type: "busy" } });
    const next = await p.pump("session.error", { sessionID: "s1" });
    check("session.error without error field: empty detail",
        next.length === 1 && argState(next[0]) === "done"
        && next[0].env.OPENCODE_STATE_DETAIL === "",
        JSON.stringify(next));
}

{
    // session.error without sessionID: detail still forwarded, no lookups.
    const p = makePlugin();
    await p.pump("session.error", { error: { name: "E", message: "m" } });
    const batch = p.lines();
    check("session.error without sessionID: done with detail, empty title/message",
        batch.length === 1
        && argState(batch[0]) === "done"
        && batch[0].env.OPENCODE_STATE_DETAIL === "[error] E: m"
        && batch[0].env.OPENCODE_SESSION_TITLE === ""
        && batch[0].env.OPENCODE_LAST_MESSAGE === "",
        JSON.stringify(batch));
}

{
    // API failures are non-fatal: done falls back to empty title/message.
    const p = makePlugin({
        session: {
            get: async () => { throw new Error("down"); },
            context: async () => { throw new Error("down"); },
        },
    });
    await p.pump("session.status", { sessionID: "s1", status: { type: "idle" } });
    const batch = p.lines();
    check("session API failure: done with empty title/message",
        batch.length === 1
        && argState(batch[0]) === "done"
        && batch[0].env.OPENCODE_SESSION_TITLE === ""
        && batch[0].env.OPENCODE_LAST_MESSAGE === "",
        JSON.stringify(batch));
}

{
    // Tool-call-only assistant turns are skipped; earlier text is used.
    const p = makePlugin({
        session: {
            context: async () => [
                { type: "assistant", content: [{ type: "text", text: "earlier answer" }] },
                {
                    type: "assistant",
                    content: [{ type: "tool", name: "bash", state: "completed" }],
                },
            ],
        },
    });
    await p.pump("session.status", { sessionID: "s1", status: { type: "idle" } });
    const batch = p.lines();
    check("tool-call-only last turn: falls back to earlier assistant text",
        batch.length === 1 && batch[0].env.OPENCODE_LAST_MESSAGE === "earlier answer",
        JSON.stringify(batch));
}

{
    // Non-string title is treated as missing.
    const p = makePlugin({
        session: {
            get: async () => ({ id: "s1", title: 42 }),
            context: async () => [],
        },
    });
    await p.pump("session.status", { sessionID: "s1", status: { type: "idle" } });
    const batch = p.lines();
    check("non-string title: empty string forwarded",
        batch.length === 1
        && batch[0].env.OPENCODE_SESSION_TITLE === ""
        && batch[0].env.OPENCODE_LAST_MESSAGE === "",
        JSON.stringify(batch));
}

{
    // Per-event isolation: each event resolves and carries its own session's
    // context (no cross-event leakage), even when one session's lookups are
    // slow. V2 processes events serially, so sB waits for sA.
    const p = makePlugin({
        session: {
            get: async ({ sessionID }) => ({ id: sessionID, title: `title-${sessionID}` }),
            context: async ({ sessionID }) => {
                if (sessionID === "sA") await new Promise((resolve) => setTimeout(resolve, 30));
                return [
                    { type: "assistant", content: [{ type: "text", text: `msg-${sessionID}` }] },
                ];
            },
        },
    });
    await p.pump("session.status", { sessionID: "sA", status: { type: "idle" } });
    await p.pump("permission.asked", { sessionID: "sB", action: "bash", resources: ["ls"] });
    const batch = p.lines();
    const done = batch.find((line) => argState(line) === "done");
    const ask = batch.find((line) => argState(line) === "needs-input");
    check("serial events: sA done carries sA title+message",
        !!done
        && done.env.OPENCODE_SESSION_TITLE === "title-sA"
        && done.env.OPENCODE_LAST_MESSAGE === "msg-sA",
        JSON.stringify(batch));
    check("serial events: sB needs-input carries sB title+message",
        !!ask
        && ask.env.OPENCODE_SESSION_TITLE === "title-sB"
        && ask.env.OPENCODE_LAST_MESSAGE === "msg-sB",
        JSON.stringify(batch));
}

{
    // busy right after a previous running state: still resets via off.
    const p = makePlugin();
    await p.pump("session.status", { sessionID: "s1", status: { type: "busy" } });
    await p.pump("session.status", { sessionID: "s1", status: { type: "retry" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const batch = p.lines();
    check("session.status retry: no state change",
        batch.length === 2 && states(batch).join(",") === "off,running",
        JSON.stringify(batch));
}

if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log("PASS: all plugin event assertions");
