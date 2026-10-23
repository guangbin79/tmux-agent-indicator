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
        "TMUX_PANE": os.environ.get("TMUX_PANE"),
    },
})
with open(os.environ["TMUX_AGENT_INDICATOR_CAPTURE"], "a") as fh:
    fh.write(record + "\\n")
PY
`);
// Minimal tmux shim backed by a fixture panes file: exercises the plugin's
// session→pane routing (list-panes / pane liveness / global env) without a
// live tmux server. Tests rewrite the panes file to set the topology.
const panesFile = join(fixtureDir, "panes");
writeFileSync(panesFile, "%1|opencode|/fixture/proj\n%2|bash|/fixture/other\n");
writeFileSync(join(fixtureDir, "tmux"), `#!/usr/bin/env bash
case "\$1" in
    list-panes) cat "\$TMUX_FIXTURE_PANES" ;;
    display-message)
        for a in "\$@"; do
            [ "\$a" = "#{pid}" ] && { echo "4242"; exit 0; }
        done
        target=""
        prev=""
        for a in "\$@"; do
            [ "\$prev" = "-t" ] && target="\$a"
            prev="\$a"
        done
        grep -q "^\${target}|" "\$TMUX_FIXTURE_PANES" && echo "\$target"
        ;;
    *) ;;
esac
`);
execFileSync("chmod", ["+x", join(fixtureDir, "tmux")]);
process.env.PATH = `${fixtureDir}:${process.env.PATH}`;
process.env.TMUX_FIXTURE_PANES = panesFile;
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

// Fake V2 session domain. Overridable per instance. Default directory routes
// to the default fixture pane %1 (cwd /fixture/proj).
const makeSessionStub = (overrides = {}) => ({
    get: overrides.get ?? (async ({ sessionID }) => ({
        id: sessionID,
        title: "T",
        location: { directory: "/fixture/proj" },
    })),
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
    // Per-instance bindings file: isolates persistence tests from each other
    // and from the live /tmp/opencode file. overrides.bindingsFile shares one
    // file across instances (reload round-trip).
    process.env.TMUX_AGENT_INDICATOR_BINDINGS_FILE = overrides.bindingsFile
        ?? join(fixtureDir, `bindings-${instanceSeq - 1}.json`);
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

    // 1. session.execution.started -> off (running reset) then running with
    //    empty OPENCODE_* env (empty value = skip property application
    //    downstream).
    let batch = await p.pump("session.execution.started", { sessionID: "s1" });
    check("execution.started: off then running",
        JSON.stringify(states(batch)) === JSON.stringify(["off", "running"]),
        JSON.stringify(batch));
    check("execution.started: off has no OPENCODE_* env, running has empty values",
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

    // 8. session.execution.succeeded -> resolve title/message, then done.
    batch = await p.pump("session.execution.succeeded", { sessionID: "s1" });
    check("execution.succeeded: done with title + last message",
        batch.length === 1
        && argState(batch[0]) === "done"
        && batch[0].env.OPENCODE_SESSION_TITLE === "T"
        && batch[0].env.OPENCODE_LAST_MESSAGE === "agent says hi",
        JSON.stringify(batch));

    // 9. duplicate succeeded for the same pane -> deduped, no new command.
    batch = await p.pump("session.execution.succeeded", { sessionID: "s1" });
    check("duplicate succeeded: no new command (dedup)", batch.length === 0,
        JSON.stringify(batch));

    // 10. malformed watched event (no data) -> must not throw, no command.
    batch = await p.pump("session.viewed", {});
    check("malformed session.viewed: no throw, no command", batch.length === 0,
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
    // ESC interrupt: user abort clears styling (off), never done. The idle
    // guard is armed like session.error, so a trailing reply within 2s
    // cannot flip the pane back to running. Counters stay untouched: the
    // orphan started rebalances on the next round.
    const p = makePlugin();
    await p.pump("session.execution.started", { sessionID: "s1" });
    const batch = await p.pump("session.execution.interrupted", { sessionID: "s1" });
    check("execution.interrupted: off (not done)",
        batch.length === 1 && argState(batch[0]) === "off", JSON.stringify(batch));
    const late = await p.pump("permission.replied", { sessionID: "s1", requestID: "per_i", reply: "once" });
    check("late reply after interrupted: guard suppresses flip to running",
        late.length === 0, JSON.stringify(late));
    const rebalance = [];
    rebalance.push(...await p.pump("session.execution.started", { sessionID: "s1" }));
    rebalance.push(...await p.pump("session.execution.succeeded", { sessionID: "s1" }));
    check("orphan started rebalances: next round still reaches done",
        JSON.stringify(states(rebalance)) === JSON.stringify(["off", "running", "done"]),
        JSON.stringify(rebalance));
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
    // API failures are non-fatal: the session cannot be routed (no directory
    // available), so the event is dropped instead of fallback-styling an
    // arbitrary pane.
    const p = makePlugin({
        session: {
            get: async () => { throw new Error("down"); },
            context: async () => { throw new Error("down"); },
        },
    });
    const batch = await p.pump("session.execution.succeeded", { sessionID: "s1" });
    check("session API failure: unroutable event is dropped", batch.length === 0,
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
    await p.pump("session.execution.succeeded", { sessionID: "s1" });
    const batch = p.lines();
    check("tool-call-only last turn: falls back to earlier assistant text",
        batch.length === 1 && batch[0].env.OPENCODE_LAST_MESSAGE === "earlier answer",
        JSON.stringify(batch));
}

{
    // Non-string title is treated as missing.
    const p = makePlugin({
        session: {
            get: async () => ({ id: "s1", title: 42, location: { directory: "/fixture/proj" } }),
            context: async () => [],
        },
    });
    await p.pump("session.execution.succeeded", { sessionID: "s1" });
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
            get: async ({ sessionID }) => ({
                id: sessionID,
                title: `title-${sessionID}`,
                location: { directory: "/fixture/proj" },
            }),
            context: async ({ sessionID }) => {
                if (sessionID === "sA") await new Promise((resolve) => setTimeout(resolve, 30));
                return [
                    { type: "assistant", content: [{ type: "text", text: `msg-${sessionID}` }] },
                ];
            },
        },
    });
    await p.pump("session.execution.succeeded", { sessionID: "sA" });
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
    // Repeated started for the same pane: deduped to the first off,running.
    const p = makePlugin();
    await p.pump("session.execution.started", { sessionID: "s1" });
    await p.pump("session.execution.started", { sessionID: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const batch = p.lines();
    check("repeated execution.started: no state change",
        batch.length === 2 && states(batch).join(",") === "off,running",
        JSON.stringify(batch));
}

// --- routing gate: foreign sessions must not style any pane ------------------
// Regression harness for the red→blue crosstalk: a headless delegation's
// execution.started must never reach another pane, via prefix match or via
// the agent-state.sh no-TMUX_PANE fallback (which picks the first done pane).
{
    // Topology: %5 opencode in /w/proj, %6 opencode in /w/other.
    writeFileSync(panesFile, "%5|opencode|/w/proj\n%6|opencode|/w/other\n");
    const mk = (directory) => makePlugin({
        session: {
            get: async ({ sessionID }) => ({ id: sessionID, title: "T", location: { directory } }),
            context: async () => [{ type: "assistant", content: [{ type: "text", text: "m" }] }],
        },
    });

    // A. Exact-match routing: a session in a SUBDIRECTORY of a pane cwd must
    //    not match that pane (prefix matching routes foreign child sessions
    //    to ancestor panes).
    let p = mk("/w/proj/sub");
    let batch = await p.pump("session.execution.started", { sessionID: "child1" });
    check("routing: subdirectory session does not match ancestor pane", batch.length === 0,
        JSON.stringify(batch));

    // B. Unroutable session (no pane in its directory): dropped, never
    //    fallback-styled.
    p = mk("/elsewhere");
    batch = await p.pump("session.execution.started", { sessionID: "foreign" });
    check("routing: unroutable session is dropped (no fallback write)", batch.length === 0,
        JSON.stringify(batch));

    // C. Exact match still routes the pane's own session, via TMUX_PANE.
    p = mk("/w/other");
    batch = await p.pump("session.execution.started", { sessionID: "own" });
    check("routing: own session styles its pane via TMUX_PANE",
        JSON.stringify(states(batch)) === JSON.stringify(["off", "running"])
        && batch.every((line) => line.env.TMUX_PANE === "%6"),
        JSON.stringify(batch));

    // D. No-sessionID events keep the legacy fallback (single-pane setups);
    //    it inherits the plugin process's own TMUX_PANE (observed live: that
    //    inheritance is how fallback writes land on arbitrary panes).
    p = makePlugin();
    batch = await p.pump("permission.asked", { action: "bash", resources: [] });
    check("no-sessionID permission: fallback write without TMUX_PANE",
        batch.length === 1 && argState(batch[0]) === "needs-input"
        && batch[0].env.TMUX_PANE === process.env.TMUX_PANE,
        JSON.stringify(batch));
}

// --- binding persistence: survive plugin instance reload ---------------------
{
    writeFileSync(panesFile, "%1|opencode|/fixture/proj\n%2|bash|/fixture/other\n");
    const bindingsPath = join(fixtureDir, "bindings-roundtrip.json");
    // Corrupt seed doubles as the tolerant-read case: instance A must boot
    // and bind normally, overwriting the garbage.
    writeFileSync(bindingsPath, "{corrupt");
    const readBindings = () => {
        try { return JSON.parse(readFileSync(bindingsPath, "utf8")).bindings ?? {}; } catch { return {}; }
    };

    // Instance A: binds sX -> %1 via directory match; the binding must be
    // written through to the bindings file.
    const a = makePlugin({ bindingsFile: bindingsPath });
    const bindBatch = await a.pump("session.execution.started", { sessionID: "sX" });
    check("persist: corrupt bindings file tolerated, instance A binds normally",
        bindBatch.length === 2 && bindBatch.every((line) => line.env.TMUX_PANE === "%1"),
        JSON.stringify(bindBatch));
    check("persist: binding write-through lands in file",
        readBindings().sX === "%1", readFileSync(bindingsPath, "utf8"));

    // Simulated reload: a fresh instance whose in-memory Map starts empty;
    // the session directory deliberately no longer matches pane %1's cwd, so
    // directory matching cannot rescue routing — only the persisted binding
    // can.
    const b = makePlugin({
        bindingsFile: bindingsPath,
        session: {
            get: async ({ sessionID }) => ({ id: sessionID, title: "T", location: { directory: "/fixture/moved-away" } }),
            context: async () => [{ type: "assistant", content: [{ type: "text", text: "m" }] }],
        },
    });
    const reloadBatch = await b.pump("session.execution.started", { sessionID: "sX" });
    check("persist: reloaded instance routes via file binding despite directory mismatch",
        reloadBatch.length === 2 && reloadBatch.every((line) => line.env.TMUX_PANE === "%1"),
        JSON.stringify(reloadBatch));

    // Invalidation: the bound pane disappears; the next event must drop the
    // binding from memory AND from the file.
    writeFileSync(panesFile, "%2|bash|/fixture/other\n");
    const deadBatch = await b.pump("permission.asked", { sessionID: "sX", action: "bash", resources: [] });
    check("persist: dead-pane event dropped", deadBatch.length === 0,
        JSON.stringify(deadBatch));
    check("persist: dead-pane binding removed from file",
        !("sX" in readBindings()), readFileSync(bindingsPath, "utf8"));
}

{
    // Simulated tmux server restart: pane ids are server-lifetime-scoped and
    // reused, so bindings stamped with a previous server pid must be fully
    // discarded on load (paneAlive cannot tell the "new %1" from the old one).
    writeFileSync(panesFile, "%1|opencode|/fixture/proj\n%2|bash|/fixture/other\n");
    const restartPath = join(fixtureDir, "bindings-restart.json");
    writeFileSync(restartPath, JSON.stringify({ pid: "9999", bindings: { sR: "%1" } }));
    const c = makePlugin({
        bindingsFile: restartPath,
        session: {
            get: async ({ sessionID }) => ({ id: sessionID, title: "T", location: { directory: "/fixture/moved-away" } }),
            context: async () => [{ type: "assistant", content: [{ type: "text", text: "m" }] }],
        },
    });
    const staleBatch = await c.pump("session.execution.started", { sessionID: "sR" });
    check("persist: bindings from a dead tmux server pid are discarded on load",
        staleBatch.length === 0, JSON.stringify(staleBatch));
}

if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log("PASS: all plugin event assertions");
