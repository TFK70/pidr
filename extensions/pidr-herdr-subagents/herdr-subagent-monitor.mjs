#!/usr/bin/env node
/**
 * herdr-core status monitor for pi-subagents inspector terminals.
 *
 * herdr-core (the `hc` terminal runtime) learns a terminal's agent status
 * from OSC 7501 reports its program writes to stdout. The pi-subagents
 * inspector (`inspector-runner.mjs`) only renders a read-only dashboard and
 * never reports, so its terminal shows no working/done state in the herdr
 * agents sidebar. This wrapper runs INSTEAD of the inspector:
 *
 *   node herdr-subagent-monitor.mjs --runner <inspector-runner.mjs>
 *        --async-dir <dir> --run-id <id> [--refresh-ms N ...]
 *
 * - spawns `<node> <runner> <every other argument>` with inherited stdio,
 *   so the dashboard and its steer/stop/status controls keep working
 *   untouched, stdout/stderr are plain passthrough;
 * - polls `<asyncDir>/status.json` every second and, whenever the report
 *   changes, writes the terminal's root status (no `id=`, so it replaces
 *   the terminal's own status, not a sub-record):
 *
 *     \x1b]7501;state=<state>:app=pi-subagents[:title=<b64>][:msg=<b64>]\x1b\\
 *
 *   state mapping: queued|running → working, complete → done,
 *   failed|partial|rejected → error, stopped|paused → idle. title is the
 *   run's agent name (top-level `agent`, else the first step's, else
 *   "subagent"); msg is the current tool when there is one. title and msg
 *   are base64-encoded UTF-8: herdr-core decodes them, and plain ASCII
 *   words that happen to parse as base64 are rejected outright. Exactly
 *   one report is sent at start (working) and after that only on change;
 *   a missing or unreadable status.json means no report at all — the
 *   monitor degrades to a plain passthrough.
 *
 * The exit mirrors the child's: same exit code, or the same signal. A
 * terminal run state in status.json closes nothing here — closing the
 * terminal when the run completes is the parent extension's job
 * (`hc kill` + `hc rm` on `subagent:async-complete`).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const POLL_MS = 1_000;
const MAX_TITLE_BYTES = 192;
const MAX_MSG_BYTES = 1_024;

/** First value of `--name value` in argv, if present. */
function argValue(argv, name) {
	const at = argv.indexOf(name);
	return at !== -1 && at + 1 < argv.length ? argv[at + 1] : undefined;
}

/** argv without one `--name value` pair. */
function dropArg(argv, name) {
	const out = [...argv];
	const at = out.indexOf(name);
	if (at !== -1) out.splice(at, 2);
	return out;
}

/** status.json `state` → OSC 7501 state word; anything else → no report. */
function oscState(state) {
	switch (state) {
		case "queued":
		case "running":
			return "working";
		case "complete":
			return "done";
		case "failed":
		case "partial":
		case "rejected":
			return "error";
		case "stopped":
		case "paused":
			return "idle";
		default:
			return undefined;
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Agent name for the title: top-level `agent`, else the first step's,
 *  else "subagent" (chain runs report per-step agents only). */
function agentName(status) {
	if (typeof status.agent === "string" && status.agent) return status.agent;
	for (const step of Array.isArray(status.steps) ? status.steps : []) {
		if (isRecord(step) && typeof step.agent === "string" && step.agent) return step.agent;
	}
	return "subagent";
}

/** Current tool for the msg: top-level `currentTool`, else the first
 *  step's; absent while a run waits between turns and after it ends. */
function currentTool(status) {
	if (typeof status.currentTool === "string" && status.currentTool) return status.currentTool;
	for (const step of Array.isArray(status.steps) ? status.steps : []) {
		if (isRecord(step) && typeof step.currentTool === "string" && step.currentTool) {
			return step.currentTool;
		}
	}
	return undefined;
}

/** Display-safe base64: control characters become '-', and the UTF-8
 *  encoding is capped at maxBytes on a character boundary (the same shape
 *  pi-subagents' own OSC 7501 writer uses). */
function encodeText(text, maxBytes) {
	const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, "-");
	let bytes = Buffer.from(cleaned, "utf8");
	if (bytes.length > maxBytes) {
		let end = maxBytes;
		while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
		bytes = bytes.subarray(0, end);
	}
	return bytes.toString("base64");
}

let lastReport;

/** Write the root OSC 7501 status — once at start, then only on change. */
function report(state, title, msg) {
	const pairs = [`state=${state}`, "app=pi-subagents"];
	if (title !== undefined) pairs.push(`title=${encodeText(title, MAX_TITLE_BYTES)}`);
	if (msg !== undefined) pairs.push(`msg=${encodeText(msg, MAX_MSG_BYTES)}`);
	const sequence = `\u001b]7501;${pairs.join(":")}\u001b\\`;
	if (sequence === lastReport) return;
	lastReport = sequence;
	try {
		process.stdout.write(sequence);
	} catch {
		// stdout is gone (terminal closed): reporting is best-effort
	}
}

/** status.json of the run, or undefined when absent/unreadable/another
 *  run's (torn writes retry on the next poll). */
function readStatus(statusPath, runId) {
	let raw;
	try {
		raw = readFileSync(statusPath, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) return undefined;
		if (parsed.runId !== undefined && parsed.runId !== runId) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

const argv = process.argv.slice(2);
const runner = argValue(argv, "--runner");
const asyncDir = argValue(argv, "--async-dir");
const runId = argValue(argv, "--run-id");
if (!runner || !asyncDir || !runId) {
	process.stderr.write("herdr-subagent-monitor: --runner, --async-dir and --run-id are required\n");
	process.exit(2);
}

const statusPath = join(asyncDir, "status.json");

const sync = () => {
	const status = readStatus(statusPath, runId);
	if (!status) {
		// Start report before any status exists: the terminal is working.
		if (lastReport === undefined) report("working", "subagent");
		return;
	}
	const state = oscState(status.state);
	if (state === undefined) return;
	report(state, agentName(status), currentTool(status));
};

const child = spawn(process.execPath, [runner, ...dropArg(argv, "--runner")], { stdio: "inherit" });

sync();
const timer = setInterval(() => {
	try {
		sync();
	} catch {
		// polling must never kill the terminal
	}
}, POLL_MS);
timer.unref?.();

child.once("close", (code, signal) => {
	clearInterval(timer);
	if (signal) {
		try {
			process.kill(process.pid, signal);
		} catch {
			process.exit(1);
		}
		return;
	}
	process.exit(code ?? 0);
});
