#!/usr/bin/env node
/**
 * herdr-core monitor for pi-subagents runs: native pi transcript + OSC 7501.
 *
 * herdr-core (the `hc` terminal runtime) learns a terminal's agent status
 * from OSC 7501 reports its program writes to stdout. The pi-subagents
 * inspector (`inspector-runner.mjs`) only renders a plain-text dashboard and
 * never reports, so its terminal shows no working/done state in the herdr
 * agents sidebar. This wrapper replaces the inspector terminal's program:
 *
 *   node herdr-subagent-monitor.mjs [--runner <inspector-runner.mjs>]
 *        --async-dir <dir> --run-id <id> [--index N] [--refresh-ms N]
 *        [--pi-package-dir <pi-coding-agent package>] [--allow-steer 0|1]
 *        [--allow-stop 0|1] [--session-roots s] [--mission-path p]
 *
 * What it does:
 *
 * - polls `<asyncDir>/status.json` every refresh interval and, whenever the
 *   report changes, writes the terminal's root status (no `id=`, so it
 *   replaces the terminal's own status, not a sub-record):
 *
 *     ESC ] 7501 ; state=<state>:app=pi-subagents[:title=<b64>][:msg=<b64>] ESC BS
 *
 *   state mapping: queued|running -> working, complete -> done,
 *   failed|partial|rejected -> error, stopped|paused -> idle. title is the
 *   run's agent name, msg is the current tool. Exactly one report is sent at
 *   start (working) and after that only on change.
 * - renders the run's session transcript with pi's own TUI components
 *   (UserMessageComponent, AssistantMessageComponent with thinking blocks,
 *   ToolExecutionComponent with the built-in tool renderers and diff
 *   highlighting, markdown via getMarkdownTheme, theme colors), following
 *   the session JSONL live (tail): new entries appear on the next poll.
 *   The pi package is resolved from --pi-package-dir (passed by the pidr
 *   extension from the wrapper's PIDR_PI_PACKAGE_DIR) or the same env var.
 *   Which session is shown: --index selects that chain/parallel child,
 *   single-step runs show their only step, aggregate runs follow
 *   status.currentStep.
 * - keeps the inspector's controls: `steer <message>` (or plain text for a
 *   child/single inspector), `stop`, `status` — implemented directly against
 *   the run's control inbox files (`<asyncDir>/control/{steer,stop}-requests`),
 *   the same file protocol pi-subagents' control-channel.js uses. The
 *   terminal stays read-only for the run itself: closing it changes nothing.
 * - degrades instead of dying: without a usable pi package it falls back to
 *   spawning the classic `<runner>` dashboard unchanged (plain passthrough +
 *   OSC 7501); without a runner it shows the run header and status only.
 *   Render errors never kill the process — a failed block becomes an error
 *   line in the transcript.
 *
 * The exit mirrors the child's in fallback mode: same exit code, or the same
 * signal. Closing the terminal when the run completes is the parent
 * extension's job (`hc kill` + `hc rm` on `subagent:async-complete`).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";

const POLL_MS = 1_000;
const MIN_REFRESH_MS = 250;
const MAX_TITLE_BYTES = 192;
const MAX_MSG_BYTES = 1_024;
const OUTPUT_PAD = 1; // pi's default output padding (SETTINGS_DEFAULTS.outputPad)
const CHROME_LINES = 6; // header(2) + blank + blank + hint + prompt

/** Control inbox layout of pi-subagents v0.80.0 (src/runs/background/control-channel.js). */
const CONTROL_DIR = "control";
const STEER_REQUESTS_DIR = "steer-requests";
const STOP_REQUESTS_DIR = "stop-requests";
const STEER_INBOX_CLOSED_FILE = "steer-inbox-closed.json";
const STOP_INBOX_CLOSED_FILE = "stop-inbox-closed.json";
const MAX_STEER_MESSAGE_BYTES = 128 * 1024;

/** Terminal control sequences, built from char codes so this file stays
 *  plain ASCII regardless of how it was transported. */
const ESC = String.fromCharCode(27);
const BS = String.fromCharCode(92);
const CSI = ESC + "[";
const CLEAR_HOME = CSI + "2J" + CSI + "H";
/** Control characters (C0 plus DEL) that must not enter an OSC title/msg. */
const CONTROL_CHARS = new RegExp(
	"[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]",
	"g",
);

/** `--name value` pairs into a map; unknown flags are tolerated (the pidr
 *  extension and pi-subagents' inspector launches pass a superset of what is
 *  used here). */
function parseArgs(argv) {
	const values = new Map();
	for (let index = 0; index + 1 < argv.length; index += 2) {
		const key = argv[index];
		if (typeof key !== "string" || !key.startsWith("--")) continue;
		values.set(key, argv[index + 1]);
	}
	return values;
}

/** status.json `state` -> OSC 7501 state word; anything else -> no report. */
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
	const cleaned = text.replace(CONTROL_CHARS, "-");
	let bytes = Buffer.from(cleaned, "utf8");
	if (bytes.length > maxBytes) {
		let end = maxBytes;
		while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
		bytes = bytes.subarray(0, end);
	}
	return bytes.toString("base64");
}

let lastReport;

/** Write the root OSC 7501 status — once at start, then only on change.
 *  A blocked report carries kind=question, the same shape pi's own
 *  ProgramStatusReporter writes for a blocked program. */
function report(state, title, msg) {
	const pairs = ["state=" + state, "app=pi-subagents"];
	if (state === "blocked") pairs.push("kind=question");
	if (title !== undefined) pairs.push("title=" + encodeText(title, MAX_TITLE_BYTES));
	if (msg !== undefined) pairs.push("msg=" + encodeText(msg, MAX_MSG_BYTES));
	const payload = ESC + "]7501;" + pairs.join(":") + ESC + BS;
	if (payload === lastReport) return;
	lastReport = payload;
	try {
		process.stdout.write(payload);
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

/** Load pi's public module and initialize the theme. Returns undefined when
 *  the package is missing or cannot run headlessly (the caller degrades). */
async function loadPi(piPackageDir) {
	if (!piPackageDir) return undefined;
	const entry = join(piPackageDir, "dist", "index.js");
	try {
		if (!existsSync(entry)) return undefined;
		const pi = await import(pathToFileURL(entry).href);
		pi.initTheme();
		// The theme singleton lives in the same module instance as initTheme.
		const themeModule = await import(
			pathToFileURL(join(piPackageDir, "dist", "modes", "interactive", "theme", "theme.js")).href
		);
		if (!themeModule.theme) return undefined;
		return { pi, theme: themeModule.theme };
	} catch {
		return undefined;
	}
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Session transcript built from session JSONL entries with pi's own
 *  components — the same mapping interactive-mode uses in
 *  renderSessionItems(): assistant messages (thinking included), user
 *  messages (with skill blocks), toolCall+toolResult paired into one
 *  ToolExecutionComponent, custom/compaction/branch summaries. Blocks cache
 *  their rendered lines; only invalidated blocks re-render on repaint. */
class TranscriptRenderer {
	constructor(pi, theme) {
		this.pi = pi;
		this.theme = theme;
		this.markdownTheme = pi.getMarkdownTheme();
		// ToolExecutionComponent needs a TUI only to request repaints; this
		// renderer repaints on its own schedule, so the request is a no-op.
		this.ui = { requestRender() {} };
		this.cwd = process.cwd();
		this.toolDefs = this.buildToolDefs(this.cwd);
		this.blocks = []; // { component?: object, lines?: string[] }
		this.pendingTools = new Map(); // toolCallId -> block
		/** Open ask_user_question calls by tool call id -> question text (""
		 *  when the call carries none). Drives the terminal's blocked status:
		 *  a subagent waiting on the user must not read as working. */
		this.questions = new Map();
	}

	/** Built-in tool renderers (native call/result/diff rendering) keyed by
	 *  tool name; unknown tools fall back to pi's own generic tool box. */
	buildToolDefs(cwd) {
		const factories = {
			read: this.pi.createReadToolDefinition,
			bash: this.pi.createBashToolDefinition,
			edit: this.pi.createEditToolDefinition,
			write: this.pi.createWriteToolDefinition,
			grep: this.pi.createGrepToolDefinition,
			find: this.pi.createFindToolDefinition,
			ls: this.pi.createLsToolDefinition,
		};
		const defs = {};
		for (const [name, factory] of Object.entries(factories)) {
			try {
				defs[name] = factory(cwd);
			} catch {
				// a renderer that cannot build is dropped; the tool then uses the fallback look
			}
		}
		return defs;
	}

	/** Re-target path rendering once the run's cwd is known. */
	setCwd(cwd) {
		if (typeof cwd !== "string" || !cwd || cwd === this.cwd) return;
		this.cwd = cwd;
		this.toolDefs = this.buildToolDefs(cwd);
		this.invalidate();
	}

	reset() {
		this.blocks = [];
		this.pendingTools.clear();
		this.questions.clear();
	}

	/** The first still-unanswered ask_user_question, or undefined when the
	 *  agent is not waiting on the user. */
	pendingQuestion() {
		for (const question of this.questions.values()) return question;
		return undefined;
	}

	push(component) {
		const block = { component, lines: undefined };
		this.blocks.push(block);
		return block;
	}

	pushLines(lines) {
		this.blocks.push({ lines });
	}

	/** Drop every cached line (resize, cwd change). */
	invalidate() {
		for (const block of this.blocks) if (block.component) block.lines = undefined;
	}

	/** One session file line (a FileEntry); never throws — a failed block
	 *  becomes an inline error note instead. */
	applyEntry(entry) {
		if (!isRecord(entry)) return;
		try {
			if (entry.type === "custom") return; // display-only; needs the extension's entry renderer
			const messages = this.pi.sessionEntryToContextMessages(entry);
			for (const message of Array.isArray(messages) ? messages : []) this.applyMessage(message);
		} catch (error) {
			this.pushLines([this.theme.fg("error", "[unrenderable entry: " + messageOf(error) + "]")]);
		}
	}

	applyMessage(message) {
		if (!isRecord(message)) return;
		switch (message.role) {
			case "system":
				return;
			case "user": {
				const text = this.userText(message);
				if (!text) return;
				if (this.blocks.length > 0) this.pushLines([""]); // Spacer(1) before user messages, as in pi
				const skillBlock = this.pi.parseSkillBlock(text);
				if (skillBlock) {
					this.push(new this.pi.SkillInvocationMessageComponent(skillBlock, this.markdownTheme, OUTPUT_PAD));
					if (skillBlock.userMessage) {
						this.pushLines([""]);
						this.push(new this.pi.UserMessageComponent(skillBlock.userMessage, this.markdownTheme, OUTPUT_PAD));
					}
				} else {
					this.push(new this.pi.UserMessageComponent(text, this.markdownTheme, OUTPUT_PAD));
				}
				return;
			}
			case "assistant": {
				this.push(new this.pi.AssistantMessageComponent(message, false, this.markdownTheme));
				for (const content of Array.isArray(message.content) ? message.content : []) {
					if (!isRecord(content) || content.type !== "toolCall") continue;
					const component = new this.pi.ToolExecutionComponent(
						content.name,
						content.id,
						content.arguments,
						{ outputPad: OUTPUT_PAD },
						this.toolDefs[content.name],
						this.ui,
						this.cwd,
					);
					const block = this.push(component);
					this.pendingTools.set(content.id, block);
					if (content.name === "ask_user_question") {
						const args = isRecord(content.arguments) ? content.arguments : {};
						const questions = Array.isArray(args.questions) ? args.questions : [];
						let text = "";
						for (const question of questions) {
							if (isRecord(question) && typeof question.question === "string" && question.question.trim()) {
								text = question.question.trim();
								break;
							}
						}
						this.questions.set(content.id, text);
					}
				}
				return;
			}
			case "toolResult": {
				const block = this.pendingTools.get(message.toolCallId);
				this.questions.delete(message.toolCallId);
				if (!block) return; // result without a call in this transcript
				this.pendingTools.delete(message.toolCallId);
				block.component.updateResult(message);
				block.lines = undefined; // re-render with the result attached
				return;
			}
			case "custom": {
				if (message.display) {
					this.push(new this.pi.CustomMessageComponent(message, undefined, this.markdownTheme, OUTPUT_PAD));
				}
				return;
			}
			case "compactionSummary":
				this.pushLines([""]);
				this.push(new this.pi.CompactionSummaryMessageComponent(message, this.markdownTheme, OUTPUT_PAD));
				return;
			case "branchSummary":
				this.pushLines([""]);
				this.push(new this.pi.BranchSummaryMessageComponent(message, this.markdownTheme, OUTPUT_PAD));
				return;
			default:
				return;
		}
	}

	userText(message) {
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((block) => isRecord(block) && block.type === "text")
			.map((block) => block.text)
			.join("");
	}

	/** All transcript lines, rendering only uncached blocks. */
	lines(width) {
		const out = [];
		for (const block of this.blocks) {
			if (block.lines === undefined) {
				try {
					block.lines = block.component ? block.component.render(width) : [];
				} catch (error) {
					block.lines = [this.theme.fg("error", "[render error: " + messageOf(error) + "]")];
				}
			}
			out.push(...block.lines);
		}
		return out;
	}
}

/** Incremental reader of a growing session JSONL: remembers the read offset,
 *  buffers a torn last line, and rebuilds from zero when the file shrinks
 *  (a new step's session replacing the followed one). */
class SessionTail {
	constructor() {
		this.file = undefined;
		this.fd = undefined;
		this.offset = 0;
		this.partial = "";
	}

	/** Switch the followed file; true when it changed (caller resets state). */
	setFile(file) {
		if (this.file === file) return false;
		this.close();
		this.file = file;
		this.partial = "";
		return true;
	}

	close() {
		if (this.fd !== undefined) {
			try {
				closeSync(this.fd);
			} catch {
				// already closed by the OS
			}
		}
		this.fd = undefined;
		this.offset = 0;
	}

	/** Complete entries appended since the last poll. */
	poll() {
		const entries = [];
		if (!this.file) return entries;
		let size;
		try {
			size = statSync(this.file).size;
		} catch {
			return entries; // not created yet
		}
		if (this.fd === undefined || size < this.offset) {
			this.close();
			this.partial = "";
			try {
				this.fd = openSync(this.file, "r");
			} catch {
				return entries;
			}
		}
		let remaining = size - this.offset;
		while (remaining > 0) {
			const chunk = Buffer.alloc(Math.min(remaining, 1 << 20));
			let read = 0;
			try {
				read = readSync(this.fd, chunk, 0, chunk.length, this.offset);
			} catch {
				return entries;
			}
			if (read <= 0) break;
			this.offset += read;
			remaining -= read;
			this.partial += chunk.toString("utf8", 0, read);
		}
		const lines = this.partial.split("\n");
		this.partial = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				entries.push(JSON.parse(trimmed));
			} catch {
				// torn or malformed line: skip it
			}
		}
		return entries;
	}
}

/** The session JSONL the view follows: the --index child, the only step of
 *  a single run, or the currently active step of an aggregate run. */
function followedSessionFile(status, index) {
	const steps = Array.isArray(status?.steps) ? status.steps : [];
	const stepAt = (i) => {
		const step = steps[i];
		return isRecord(step) && typeof step.sessionFile === "string" ? step.sessionFile : undefined;
	};
	if (index !== undefined) return stepAt(index);
	if (steps.length === 1) return stepAt(0);
	const current = Number.isInteger(status?.currentStep) ? status.currentStep : 0;
	return stepAt(current);
}

/** Atomic JSON drop into a control inbox directory (temp + rename, the same
 *  protocol writeAtomicJson uses). */
function writeRequestJson(filePath, payload) {
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, "." + basename(filePath) + "." + process.pid + "." + Date.now() + ".tmp");
	writeFileSync(temp, JSON.stringify(payload), "utf8");
	try {
		renameSync(temp, filePath);
	} finally {
		try {
			rmSync(temp, { force: true });
		} catch {
			// best effort cleanup
		}
	}
}

/** Elapsed mm:ss / hh:mm:ss for the run header. */
function formatDuration(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const mmss = String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
	return hours > 0 ? hours + ":" + mmss : mmss;
}

function stateToken(state) {
	switch (state) {
		case "queued":
		case "running":
			return "warning";
		case "complete":
			return "success";
		case "failed":
		case "partial":
		case "rejected":
			return "error";
		case "stopped":
		case "paused":
			return "muted";
		default:
			return "dim";
	}
}

/** Build the run header lines from status.json. `needsYou` marks an
 *  unanswered ask_user_question in the followed transcript. */
function headerLines(theme, status, runId, index, sessionLive, needsYou) {
	if (!status) {
		return [
			theme.fg("accent", theme.bold("pi-subagents")) + " " + theme.fg("dim", "run " + runId),
			theme.fg("dim", "Waiting for run lifecycle status…"),
		];
	}
	const steps = Array.isArray(status.steps) ? status.steps : [];
	const stepIndex = index !== undefined ? index : Number.isInteger(status.currentStep) ? status.currentStep : 0;
	const shownStep = steps[stepIndex];
	const shownAgent = isRecord(shownStep) && typeof shownStep.agent === "string" && shownStep.agent ? shownStep.agent : agentName(status);
	const parts = [theme.fg("accent", theme.bold(shownAgent))];
	parts.push(theme.fg(stateToken(status.state), String(status.state)));
	if (isRecord(shownStep) && typeof shownStep.model === "string" && shownStep.model) {
		parts.push(theme.fg("dim", shownStep.model));
	}
	if (index !== undefined || steps.length > 1) {
		const total = steps.length || 1;
		parts.push(theme.fg("dim", "step " + Math.min(stepIndex + 1, total) + "/" + total));
	}
	if (Number.isFinite(status.startedAt)) {
		const end = Number.isFinite(status.endedAt) ? status.endedAt : Date.now();
		parts.push(theme.fg("dim", formatDuration(end - status.startedAt)));
	}
	if (Number.isInteger(status.turnCount)) parts.push(theme.fg("dim", "turn " + status.turnCount));
	const tool = currentTool(status);
	if (tool) parts.push(theme.fg("warning", tool));
	if (needsYou) parts.push(theme.fg("error", theme.bold("needs you")));
	const detail = [theme.fg("dim", "run " + runId), theme.fg("dim", sessionLive ? "transcript live" : "transcript pending")];
	return [parts.join(theme.fg("dim", " · ")), detail.join(theme.fg("dim", " · "))];
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const asyncDir = args.get("--async-dir");
const runId = args.get("--run-id");
if (!asyncDir || !runId) {
	process.stderr.write("herdr-subagent-monitor: --async-dir and --run-id are required\n");
	process.exit(2);
}
const indexRaw = args.get("--index");
const index = indexRaw === undefined ? undefined : Number(indexRaw);
if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
	process.stderr.write("herdr-subagent-monitor: --index must be a non-negative integer\n");
	process.exit(2);
}
const refreshRaw = args.get("--refresh-ms");
const refreshMs = refreshRaw === undefined ? POLL_MS : Number(refreshRaw);
if (!Number.isInteger(refreshMs) || refreshMs < MIN_REFRESH_MS) {
	process.stderr.write("herdr-subagent-monitor: --refresh-ms must be an integer >= " + MIN_REFRESH_MS + "\n");
	process.exit(2);
}
const runner = args.get("--runner");
const allowSteer = args.get("--allow-steer") !== "false";
const allowStop = args.get("--allow-stop") !== "false";
const piPackageDir = args.get("--pi-package-dir") ?? process.env.PIDR_PI_PACKAGE_DIR?.trim();

const statusPath = join(asyncDir, "status.json");
let lastStatus; // most recent status.json payload (also used by controls)

/** Root OSC 7501 report from status.json (unchanged behavior), overridden to
 *  `blocked` while the followed transcript has an unanswered
 *  ask_user_question: a subagent waiting on the user must not read as
 *  working in the herdr agents sidebar. */
function reportFrom(status, blockedMessage) {
	if (!status) {
		// Start report before any status exists: the terminal is working.
		if (lastReport === undefined) report("working", "subagent");
		return undefined;
	}
	const state = oscState(status.state);
	if (state === undefined) return status;
	if (state === "working" && blockedMessage !== undefined) {
		report("blocked", agentName(status), blockedMessage || currentTool(status) || "ask_user_question");
	} else {
		report(state, agentName(status), currentTool(status));
	}
	return status;
}

// ---------------------------------------------------------------------------
// control channel: steer/stop via the run's file inbox
// ---------------------------------------------------------------------------

const isTerminalState = (state) => state !== "queued" && state !== "running";

function steerFileName(request) {
	return String(request.ts).padStart(13, "0") + "-" + Buffer.from(request.id).toString("base64url") + ".json";
}

function queueSteer(message) {
	if (!allowSteer) return "Authority policy does not allow steer from this inspector.";
	if (isTerminalState(String(lastStatus?.state ?? ""))) {
		return "Run '" + runId + "' is " + lastStatus.state + " and cannot be steered.";
	}
	const trimmed = message.trim();
	if (!trimmed) return "steer requires a message.";
	if (Buffer.byteLength(trimmed, "utf8") > MAX_STEER_MESSAGE_BYTES) return "steer message is too large.";
	if (existsSync(join(asyncDir, CONTROL_DIR, STEER_INBOX_CLOSED_FILE))) {
		return "Async run no longer accepts steering requests.";
	}
	const request = { type: "steer", id: randomUUID(), ts: Date.now(), message: trimmed, source: "pidr-monitor" };
	const targetIndex = index !== undefined ? index : lastStatus?.mode === "single" ? 0 : undefined;
	if (targetIndex !== undefined) {
		request.targetIndex = targetIndex;
	} else {
		const running = (Array.isArray(lastStatus?.steps) ? lastStatus.steps : [])
			.map((step, i) => (isRecord(step) && step.status === "running" ? i : undefined))
			.filter((i) => i !== undefined);
		if (running.length === 0) {
			return "No running child is available to steer. Open a child-specific inspector for a pending child.";
		}
		request.targetIndexes = running;
	}
	writeRequestJson(join(asyncDir, CONTROL_DIR, STEER_REQUESTS_DIR, steerFileName(request)), request);
	return "Steering queued for run " + runId + ".";
}

function requestStop() {
	if (!allowStop) return "Authority policy does not allow stop from this inspector.";
	if (isTerminalState(String(lastStatus?.state ?? ""))) {
		return "Run '" + runId + "' is " + lastStatus.state + " and cannot be stopped.";
	}
	if (existsSync(join(asyncDir, CONTROL_DIR, STOP_INBOX_CLOSED_FILE))) {
		return "Runner stop inbox is closed. Retry stop after runner shutdown is observed.";
	}
	const request = { type: "stop", ts: Date.now(), source: "pidr-monitor" };
	const name = String(request.ts).padStart(13, "0") + "-" + randomUUID() + ".json";
	writeRequestJson(join(asyncDir, CONTROL_DIR, STOP_REQUESTS_DIR, name), request);
	return "Stop requested for run " + runId + ".";
}

/** One input line -> a notice string (the inspector's control surface). */
function handleControl(line) {
	const command = line.trim();
	if (!command || command === "status") return "Status refreshed.";
	if (!lastStatus || lastStatus.runId !== runId) {
		return "Lifecycle status for run '" + runId + "' is unavailable.";
	}
	if (command === "stop") return requestStop();
	if (command.startsWith("steer ")) return queueSteer(command.slice("steer ".length));
	if (command.startsWith("reply ")) {
		return "Supervisor replies are owned by the parent Pi session; use subagent_supervisor/intercom there.";
	}
	if (index === undefined && lastStatus.mode !== "single") {
		return "Plain guidance requires a child-specific inspector. Use steer <message> to target all running children.";
	}
	return queueSteer(command);
}

// ---------------------------------------------------------------------------
// fallback: the classic plain-text inspector dashboard behind this same
// OSC 7501 wrapper (used when pi's package is unavailable)
// ---------------------------------------------------------------------------

function runFallbackDashboard() {
	reportFrom(readStatus(statusPath, runId));
	const timer = setInterval(() => {
		try {
			reportFrom(readStatus(statusPath, runId));
		} catch {
			// polling must never kill the terminal
		}
	}, refreshMs);
	timer.unref?.();
	if (!runner) {
		process.stdout.write(
			CLEAR_HOME +
				"pi-subagents monitor\n\nNo Pi package for native rendering and no --runner dashboard.\nRun " +
				runId +
				" is tracked; OSC 7501 status reports continue.\n",
		);
		return;
	}
	const passthrough = [...argv];
	const at = passthrough.indexOf("--runner");
	if (at !== -1) passthrough.splice(at, 2);
	const child = spawn(process.execPath, [runner, ...passthrough], { stdio: "inherit" });
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
}

// ---------------------------------------------------------------------------
// native rendering mode
// ---------------------------------------------------------------------------

async function runNative(piModule) {
	const { pi, theme } = piModule;
	const renderer = new TranscriptRenderer(pi, theme);
	const tail = new SessionTail();
	let followedFile;
	let notice = "";
	let lastPainted;

	const width = () => Math.max(20, (process.stdout.columns || 100) - 2); // pi renders chat inside a 1-cell border
	const viewport = () => Math.max(1, (process.stdout.rows || 40) - CHROME_LINES);

	const paint = (force) => {
		try {
			const question = renderer.pendingQuestion();
			const lines = [...headerLines(theme, lastStatus, runId, index, Boolean(followedFile), question !== undefined), ""];
			const transcript = renderer.lines(width());
			const visible = transcript.slice(-viewport());
			if (transcript.length > visible.length) {
				lines.push(
					theme.fg("muted", "… " + (transcript.length - visible.length) + " earlier lines not shown (live tail)"),
				);
			}
			lines.push(
				...(visible.length
					? visible
					: [
							theme.fg(
								"dim",
								followedFile
									? "Waiting for the run's session transcript…"
									: "No Pi session for this step yet (external runners may have none).",
							),
						]),
			);
			lines.push("");
			lines.push(
				theme.fg(
					"dim",
					"read-only · " +
						(notice ? notice + " · " : "") +
						"controls: steer <message> | stop | status · closing does not stop the run",
				),
			);
			const text = CLEAR_HOME + lines.join("\n") + "\n> ";
			if (!force && text === lastPainted) return;
			lastPainted = text;
			process.stdout.write(text);
		} catch (error) {
			try {
				process.stdout.write(CLEAR_HOME + "[pidr-monitor] render failed: " + messageOf(error) + "\n> ");
			} catch {
				// stdout is gone: nothing left to do
			}
		}
	};

	const tick = () => {
		try {
			const status = readStatus(statusPath, runId);
			lastStatus = status;
			if (status && typeof status.cwd === "string") renderer.setCwd(status.cwd);
			const file = followedSessionFile(status, index);
			if (file && file !== followedFile) {
				followedFile = file;
				if (tail.setFile(file)) renderer.reset();
			}
			for (const entry of tail.poll()) renderer.applyEntry(entry);
			reportFrom(status, renderer.pendingQuestion());
			paint(false);
		} catch {
			// polling must never kill the terminal
		}
	};

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	rl.on("line", (line) => {
		try {
			notice = handleControl(line);
		} catch (error) {
			notice = "Control error: " + messageOf(error);
		}
		tick();
	});
	rl.on("close", () => {
		// stdin gone (terminal closed): nothing more to serve
	});

	process.stdout.on?.("resize", () => {
		renderer.invalidate();
		paint(true);
	});

	tick();
	const timer = setInterval(tick, refreshMs);
	timer.unref?.();
}

const native = await loadPi(piPackageDir);
if (native) {
	await runNative(native);
} else {
	runFallbackDashboard();
}
