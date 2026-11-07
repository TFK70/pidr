/**
 * pidr herdr-core subagent visibility
 *
 * pi-subagents background runs are invisible to the new-generation herdr
 * app (herdr-core, CLI `hc`): herdr-core only tracks terminals it started
 * itself, and async subagents spawn as detached processes. This extension
 * gives them a face in the herdr UI without touching pi-subagents:
 *
 * - auto-open: on the pi-subagents `subagent:async-started` event, start
 *   `<hc> run --bg --name pi-sub-<id> -- node <PI_SUBAGENTS_DIR>/inspector-runner.mjs
 *   --async-dir <dir> --run-id <id> --refresh-ms 1000` — a live read-only
 *   dashboard terminal parented to pi's own herdr terminal (`--parent`
 *   defaults to the launching terminal, which inside herdr is the pi panel).
 * - status: the inspector itself never reports, so its terminal would show
 *   no working/done state in the herdr agents sidebar. It therefore runs
 *   behind the sibling wrapper `herdr-subagent-monitor.mjs` (loaded in
 *   place from this flake source directory), which passes the dashboard
 *   through unchanged and translates `<asyncDir>/status.json` into the
 *   terminal's root OSC 7501 status (`state=…:app=pi-subagents:title=…`).
 *   herdr then also derives the parent's status from these terminals
 *   (a parent takes its most urgent sub-agent's place) — nothing extra is
 *   needed here for that.
 * - auto-close: on `subagent:async-complete` the run's terminal is closed
 *   fire-and-forget (`<hc> kill <address-or-name>` makes it finished,
 *   `<hc> rm <addr>` drops it from the core), and `session_shutdown`
 *   closes every still-tracked terminal so inspectors of an ended session
 *   do not linger. PIDR_HERDR_AUTOCLOSE=0 keeps them open instead.
 * - inspector plugin: register `"pidr-herdr-core"` in pi-subagents'
 *   inspector registry (`pi-subagents:inspector-register:v1` on the
 *   `pi.events` bus), so explicit inspector.open/status/close drive the
 *   same terminals through the launch.executable + launch.argv command
 *   pi-subagents itself prepared, also behind the monitor.
 *
 * No panes: subagent terminals live only in the herdr agents sidebar
 * (nothing here talks to herdr-app anymore).
 *
 * Fully inert outside herdr: the extension activates only when
 * HC_TERMINAL_ID or HC_TERMINAL_SOCKET is set and a herdr-core binary
 * resolves (PIDR_HC_BIN overrides the lookup; `hc` is tried before
 * `herdr-core`, and only PATH-resolvable binaries count because `hc` may
 * be a shell alias). PIDR_HERDR_SUBAGENTS=0 disables everything. Without
 * PI_SUBAGENTS_DIR (set by the Nix wrapper) or with a missing
 * inspector-runner.mjs, auto-open is off, but the inspector plugin still
 * registers: open() runs the launch command pi-subagents provides, which
 * does not need that path. A missing monitor wrapper is logged and
 * degrades to the bare inspector (terminal without OSC 7501 status).
 *
 * Every external call is fire-and-forget with logged failures, so neither
 * the event handler nor the plugin callbacks can block or crash a session.
 * Inspector terminals are read-only dashboards: closing one only kills its
 * own terminal, never the subagent run.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAG = "[pidr-herdr-subagents]";

/** pi.events channels of pi-subagents v0.80.0 (src/shared/types.js and
 *  src/api/inspectors.js). The package cannot be imported from a sibling
 *  `-e` extension, so the event names and shapes are restated here. */
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const INSPECTOR_REGISTER_EVENT = "pi-subagents:inspector-register:v1";

/** Inspector plugin name: 1–128 letters/digits/./_/-, must not collide with
 *  the builtin plugin names (herdr, ghostty, tmux) — the builtin `herdr`
 *  targets the old-generation pane protocol, this one targets herdr-core. */
const PLUGIN_NAME = "pidr-herdr-core";

/** herdr-core terminal names: 1–32 chars of a-z 0-9 - _ (lowercase only),
 *  unique among live terminals. The prefix must fit plus a sanitized id. */
const NAME_PREFIX = "pi-sub-";
const NAME_MAX = 32;

/** Payload of `subagent:async-started` — only the fields used here. */
interface AsyncStartedRun {
	id: string;
	asyncDir: string;
	cwd?: string;
}

/** Minimal restatement of pi-subagents' inspector contracts
 *  (src/inspectors/types.d.ts, v0.80.0) — only what this file implements. */
interface InspectorTarget {
	runId: string;
	asyncDir: string;
	index?: number;
	status: { cwd?: string; state: string };
}

interface InspectorContext {
	cwd: string;
	signal?: AbortSignal;
	env: NodeJS.ProcessEnv;
	now?: () => Date;
	target: InspectorTarget;
}

interface InspectorLaunch {
	executable: string;
	argv: string[];
}

interface InspectorParams {
	focus?: boolean;
}

/** AgentToolResult-shaped reply expected from inspector plugin callbacks. */
interface InspectorReply {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details?: unknown;
}

/** Handle returned through the pi-subagents registration handshake. */
interface InspectorRegistration {
	dispose(): void;
}

interface InspectorRegistrationRequest {
	version: 1;
	plugin: unknown;
	result?: { ok: true; registration: InspectorRegistration } | { ok: false; error: Error };
}

/** Open inspector terminal per target key; `name` is null when herdr-core
 *  auto-assigned the name after a clash — such a terminal can only be
 *  closed by its address. In-memory only: herdr terminals outlive pi, but
 *  ownership is tracked per pi process. */
const bindings = new Map<string, { name: string | null; address?: string }>();

/** Run ids that already got an auto-opened terminal (one per run). */
const seenRuns = new Set<string>();

/** Active registration, released on session_shutdown. */
let registration: InspectorRegistration | undefined;

let hcBinCache: string | undefined | null = null; // null = not resolved yet

/** First PATH entry holding an executable `command` — the same answer
 *  `which` gives, without spawning a subprocess (the `which` binary itself
 *  may be missing, e.g. on NixOS). */
function findOnPath(command: string): string | undefined {
	if (command.includes("/")) return undefined;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		try {
			const candidate = join(dir, command);
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not in this PATH entry; keep scanning
		}
	}
	return undefined;
}

/** Resolve the herdr-core binary: PIDR_HC_BIN first (absolute values are
 *  trusted as-is), then `hc` (only when PATH-resolvable — it is often just
 *  a shell alias), then `herdr-core`. Cached for the process lifetime. */
function resolveHcBin(): string | undefined {
	if (hcBinCache !== null) return hcBinCache;
	hcBinCache = undefined;
	const override = process.env.PIDR_HC_BIN?.trim();
	if (override) hcBinCache = override.includes("/") ? override : findOnPath(override);
	hcBinCache ??= findOnPath("hc") ?? findOnPath("herdr-core");
	return hcBinCache;
}

/** Inside a herdr-core terminal, pi receives HC_TERMINAL_ID and
 *  HC_TERMINAL_SOCKET; outside herdr neither exists. */
function insideHerdrCore(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.HC_TERMINAL_ID?.trim() || env.HC_TERMINAL_SOCKET?.trim());
}

/** Activation gate: herdr-core environment + resolvable binary, unless
 *  disabled with PIDR_HERDR_SUBAGENTS=0. */
function extensionActive(env: NodeJS.ProcessEnv): boolean {
	return env.PIDR_HERDR_SUBAGENTS !== "0" && insideHerdrCore(env) && resolveHcBin() !== undefined;
}

/** Auto-closing tracked terminals (async-complete, session_shutdown):
 *  on by default, PIDR_HERDR_AUTOCLOSE=0 keeps them open. */
function autocloseEnabled(env: NodeJS.ProcessEnv): boolean {
	return env.PIDR_HERDR_AUTOCLOSE !== "0";
}

/** Standalone inspector entry shipped inside the pi-subagents package
 *  (path injected by the Nix wrapper via PI_SUBAGENTS_DIR). Missing dir or
 *  file → auto-open stays off; the inspector plugin still works. */
function inspectorRunnerPath(): string | undefined {
	const dir = process.env.PI_SUBAGENTS_DIR;
	if (!dir) return undefined;
	const runner = join(dir, "inspector-runner.mjs");
	try {
		return existsSync(runner) ? runner : undefined;
	} catch {
		return undefined;
	}
}

/** The OSC 7501 status monitor shipped next to this extension (pi loads
 *  `-e` extensions in place, so the flake source directory is the runtime
 *  directory too). Missing file → undefined, logged by the callers, which
 *  then degrade to the bare inspector (terminal without status). */
function monitorPath(): string | undefined {
	try {
		const monitor = fileURLToPath(new URL("./herdr-subagent-monitor.mjs", import.meta.url));
		return existsSync(monitor) ? monitor : undefined;
	} catch {
		return undefined;
	}
}

/** Command prefix running the inspector behind the status monitor:
 *  `node <monitor> --runner <inspector-runner>`; without a monitor, the
 *  bare `node <inspector-runner>` (reported once, then silent). */
function inspectorCommandPrefix(runner: string): string[] {
	const monitor = monitorPath();
	if (!monitor) {
		console.error(
			`${TAG} herdr-subagent-monitor.mjs not found next to the extension; inspector terminals will not report status`,
		);
		return [process.execPath, runner];
	}
	return [process.execPath, monitor, "--runner", runner];
}

/** Wrap a pi-subagents inspector launch (executable + argv, argv[0] being
 *  the inspector-runner) the same way: run the monitor in front. */
function wrapLaunchCommand(launch: InspectorLaunch): string[] {
	const monitor = monitorPath();
	if (!monitor || launch.argv.length === 0) return [launch.executable, ...launch.argv];
	return [launch.executable, monitor, "--runner", launch.argv[0], ...launch.argv.slice(1)];
}

/** Binding key: run id plus the child index of a chain step (the root
 *  inspector of a run has none). */
function targetKey(runId: string, index: number | undefined): string {
	return `${runId}|${index ?? ""}`;
}

/** `pi-sub-<sanitized run id>` inside herdr-core's 32-char a-z0-9-_ name
 *  budget; a child inspector of a chain run also carries its step index. */
function terminalName(runId: string, index?: number): string {
	const suffix = index === undefined ? "" : `-${index}`;
	const budget = NAME_MAX - NAME_PREFIX.length - suffix.length;
	const id = runId
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, Math.max(0, budget));
	return NAME_PREFIX + id + suffix;
}

/** AgentToolResult-shaped reply, mirroring the builtin inspector plugins. */
function reply(text: string, isError = false): InspectorReply {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

interface TerminalLaunch {
	name?: string;
	cwd?: string;
	command: readonly string[];
	signal?: AbortSignal;
}

/** Fire-and-forget `<hcBin> run --bg [--name n] [--cwd c] -- <command>`:
 *  start an inspector terminal parented to pi's own herdr terminal.
 *  `hc run --bg` returns as soon as the terminal starts, so `onOutcome`
 *  (optional) fires quickly with that start result and, on success, the
 *  `--json` stdout describing the new terminal; failures are reported to
 *  the caller, never thrown. */
function launchInspectorTerminal(
	hcBin: string,
	launch: TerminalLaunch,
	onOutcome?: (ok: boolean, detail: string, runStdout: string) => void,
): void {
	const args = ["run", "--bg", "--json"];
	if (launch.name) args.push("--name", launch.name);
	if (launch.cwd) args.push("--cwd", launch.cwd);
	args.push("--", ...launch.command);
	let stdout = "";
	let stderr = "";
	let settled = false;
	const settle = (ok: boolean, detail: string, runStdout = "") => {
		if (settled) return;
		settled = true;
		onOutcome?.(ok, detail, runStdout);
	};
	try {
		const child = spawn(hcBin, args, {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15_000, // --bg returns at once; a hang means a broken core
			...(launch.signal ? { signal: launch.signal } : {}),
		});
		child.stdout?.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-4096)));
		child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4096)));
		child.once("error", (e) => settle(false, e.message));
		child.once("close", (code, signal) => {
			if (code === 0) settle(true, "", stdout);
			else if (signal) settle(false, `terminated by ${signal}`);
			else settle(false, stderr.trim() || `exit code ${code}`);
		});
	} catch (e) {
		settle(false, e instanceof Error ? e.message : String(e));
	}
}

/** Terminal address from `hc run --json` stdout — a single JSON object
 *  with an `address` field (anything else, or no JSON, means no address;
 *  auto-close then falls back to the terminal name). */
function addressFromRunJson(runStdout: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(runStdout.trim());
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const address = (parsed as { address?: unknown }).address;
		return typeof address === "string" && address ? address : undefined;
	} catch {
		return undefined;
	}
}

interface TrackedOpen extends TerminalLaunch {
	hcBin: string;
	/** Binding key of the inspector target. */
	key: string;
	onOutcome?: (ok: boolean, detail: string, usedName: string | undefined) => void;
}

/** Open and track an inspector terminal. The binding is recorded up front
 *  (a racing inspector.open for the same target then sees it and does not
 *  spawn a duplicate), downgraded to unnamed when the chosen name clashes
 *  with a live terminal, and rolled back when the terminal never starts.
 *  On success the binding keeps the terminal address from the run output —
 *  auto-close targets it before the name. */
function openTrackedInspectorTerminal(open: TrackedOpen): void {
	bindings.set(open.key, { name: open.name ?? null });
	const attempt = (name: string | undefined) => {
		launchInspectorTerminal(
			open.hcBin,
			{ name, cwd: open.cwd, command: open.command, signal: open.signal },
			(ok, detail, runStdout) => {
				if (!ok && name !== undefined && !open.signal?.aborted) {
					// The name is taken by a live terminal (e.g. a leftover
					// inspector from an earlier pi session): retry once and
					// let herdr-core assign its own name.
					bindings.set(open.key, { name: null });
					attempt(undefined);
					return;
				}
				if (ok) {
					bindings.set(open.key, { name: name ?? null, address: addressFromRunJson(runStdout) });
				} else {
					bindings.delete(open.key);
					console.error(`${TAG} inspector terminal for ${open.key} failed: ${detail}`);
				}
				open.onOutcome?.(ok, detail, name);
			},
		);
	};
	attempt(open.name);
}

/** Fire-and-forget `<hcBin> rm <target>` — drops a finished terminal from
 *  the core; failures are logged and otherwise ignored. */
function removeFinishedTerminal(hcBin: string, target: string): void {
	let stderr = "";
	try {
		const child = spawn(hcBin, ["rm", target], {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 10_000,
		});
		child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4096)));
		child.once("error", (e) => console.error(`${TAG} ${hcBin} rm ${target}: ${e.message}`));
		child.once("close", (code, signal) => {
			if (code === 0) return;
			console.error(
				`${TAG} ${hcBin} rm ${target}: ${stderr.trim() || (signal ? `terminated by ${signal}` : `exit code ${code}`)}`,
			);
		});
	} catch (e) {
		console.error(`${TAG} ${hcBin} rm ${target}: ${e instanceof Error ? e.message : e}`);
	}
}

/** Fire-and-forget `<hcBin> kill <target>` then `<hcBin> rm <target>` —
 *  kill makes the terminal finished (the monitor + inspector inside die
 *  with it; the subagent run itself is untouched), rm removes the finished
 *  terminal from the core. rm runs only after a successful kill; every
 *  failure is logged and otherwise ignored. */
function closeInspectorTerminal(hcBin: string, target: string): void {
	let stderr = "";
	try {
		const child = spawn(hcBin, ["kill", target], {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 10_000,
		});
		child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4096)));
		child.once("error", (e) => console.error(`${TAG} ${hcBin} kill ${target}: ${e.message}`));
		child.once("close", (code, signal) => {
			if (code === 0) {
				removeFinishedTerminal(hcBin, target);
				return;
			}
			console.error(
				`${TAG} ${hcBin} kill ${target}: ${stderr.trim() || (signal ? `terminated by ${signal}` : `exit code ${code}`)}`,
			);
		});
	} catch (e) {
		console.error(`${TAG} ${hcBin} kill ${target}: ${e instanceof Error ? e.message : e}`);
	}
}

/** Close and forget one tracked terminal; logs when neither address nor
 *  name is known (herdr-core auto-assigned the name). */
function closeBinding(hcBin: string, key: string, binding: { name: string | null; address?: string }): void {
	const target = binding.address ?? binding.name;
	if (!target) {
		console.error(`${TAG} autoclose skipped for ${key}: no tracked address or name`);
		return;
	}
	closeInspectorTerminal(hcBin, target);
}

/** Narrow the untyped event-bus payload to the fields auto-open needs. */
function asyncStartedRun(data: unknown): AsyncStartedRun | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const event = data as { id?: unknown; asyncDir?: unknown; cwd?: unknown };
	if (typeof event.id !== "string" || !event.id) return undefined;
	if (typeof event.asyncDir !== "string" || !event.asyncDir) return undefined;
	return {
		id: event.id,
		asyncDir: event.asyncDir,
		...(typeof event.cwd === "string" && event.cwd ? { cwd: event.cwd } : {}),
	};
}

/** Narrow `subagent:async-complete` to its run id: the payload carries
 *  `runId` (and an `id` spelling of the same); anything else → ignore. */
function asyncCompleteRunId(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const event = data as { runId?: unknown; id?: unknown };
	for (const candidate of [event.runId, event.id]) {
		if (typeof candidate === "string" && candidate) return candidate;
	}
	return undefined;
}

/** Inspector plugin handed to pi-subagents: drives herdr-core terminals
 *  through the launch command pi-subagents itself prepared. */
const inspectorPlugin = {
	name: PLUGIN_NAME,
	available: (context: InspectorContext): boolean => extensionActive(context.env),
	owns: (context: InspectorContext): boolean =>
		bindings.has(targetKey(context.target.runId, context.target.index)),
	open: async (
		context: InspectorContext,
		launch: InspectorLaunch,
		_params: InspectorParams,
	): Promise<InspectorReply> => {
		try {
			const hcBin = resolveHcBin();
			if (!hcBin) {
				return reply("herdr-core binary not found; set PIDR_HC_BIN or add hc/herdr-core to PATH.", true);
			}
			const key = targetKey(context.target.runId, context.target.index);
			const existing = bindings.get(key);
			if (existing) {
				const where = existing.name ? `terminal ${existing.name}` : "an auto-named terminal";
				return reply(
					`herdr-core inspector ${where} is already open for async run ${context.target.runId}.`,
				);
			}
			// params.focus is ignored: herdr-core's `run` has no focus switch;
			// the new terminal is selected in the herdr UI.
			const [ok, detail, usedName] = await new Promise<[boolean, string, string | undefined]>(
				(resolve) => {
					openTrackedInspectorTerminal({
						hcBin,
						key,
						name: terminalName(context.target.runId, context.target.index),
						cwd: context.target.status.cwd ?? context.cwd,
						command: wrapLaunchCommand(launch),
						signal: context.signal,
						onOutcome: (outcomeOk, outcomeDetail, name) =>
							resolve([outcomeOk, outcomeDetail, name]),
					});
				},
			);
			if (!ok) return reply(`herdr-core inspector failed to start: ${detail}`, true);
			return reply(
				`Opened read-only herdr-core inspector ${usedName ? `terminal ${usedName}` : "terminal"} for async run ${context.target.runId}. Closing the terminal does not stop the run.\nControls inside the terminal: steer <message>, stop, status.`,
			);
		} catch (e) {
			return reply(`herdr-core inspector error: ${e instanceof Error ? e.message : e}`, true);
		}
	},
	status: async (context: InspectorContext): Promise<InspectorReply> => {
		const binding = bindings.get(targetKey(context.target.runId, context.target.index));
		if (!binding) {
			return reply(`No herdr-core inspector terminal is tracked for async run ${context.target.runId}.`);
		}
		const where = binding.address ?? binding.name ?? "an auto-named terminal";
		return reply(
			`herdr-core inspector ${where} is open for async run ${context.target.runId}.\nRun state: ${context.target.status.state}`,
		);
	},
	close: async (context: InspectorContext): Promise<InspectorReply> => {
		const key = targetKey(context.target.runId, context.target.index);
		const binding = bindings.get(key);
		if (!binding) {
			return reply(`No herdr-core inspector terminal is tracked for async run ${context.target.runId}.`);
		}
		bindings.delete(key);
		const target = binding.address ?? binding.name;
		if (!target) {
			return reply(
				`The herdr-core inspector for async run ${context.target.runId} has no tracked address or name (herdr-core assigned it); close the terminal in the herdr UI. The subagent run was not stopped.`,
			);
		}
		const hcBin = resolveHcBin();
		if (!hcBin) {
			return reply(
				`Cannot close herdr-core terminal ${target}: herdr-core binary not available. Close it in the herdr UI. The subagent run was not stopped.`,
				true,
			);
		}
		closeInspectorTerminal(hcBin, target);
		return reply(
			`Closed herdr-core inspector terminal ${target} for async run ${context.target.runId}. The subagent run was not stopped.`,
		);
	},
};

/** Handshake with pi-subagents' inspector registry (the same exchange as
 *  its registerInspector()): emit, read the result its listener writes back
 *  into the request. No answer → pi-subagents is absent (undefined); a
 *  rejected answer throws. */
function registerInspectorPlugin(pi: ExtensionAPI): InspectorRegistration | undefined {
	const request: InspectorRegistrationRequest = { version: 1, plugin: inspectorPlugin };
	pi.events.emit(INSPECTOR_REGISTER_EVENT, request);
	if (request.result === undefined) {
		// pi-subagents deliberately self-disables in runner children
		// (PI_SUBAGENT_CHILD=1) — no listener, nothing to plug into; stay
		// quiet so subagent logs and smoke tests keep a clean stderr.
		return undefined;
	}
	if (!request.result.ok) throw request.result.error;
	return request.result.registration;
}

export default function (pi: ExtensionAPI) {
	// Auto-open a dashboard terminal for every background subagent run. The
	// handler stays synchronous and never throws: pi-subagents emits this
	// from inside its own tool execution.
	pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data: unknown) => {
		try {
			if (!extensionActive(process.env)) return;
			const runner = inspectorRunnerPath();
			if (!runner) return; // auto-open unavailable; the plugin still serves opens
			const run = asyncStartedRun(data);
			if (!run || seenRuns.has(run.id)) return;
			seenRuns.add(run.id);
			const hcBin = resolveHcBin();
			if (!hcBin) return;
			openTrackedInspectorTerminal({
				hcBin,
				key: targetKey(run.id, undefined),
				name: terminalName(run.id),
				cwd: run.cwd,
				command: [
					...inspectorCommandPrefix(runner),
					"--async-dir",
					run.asyncDir,
					"--run-id",
					run.id,
					"--refresh-ms",
					"1000",
				],
			});
		} catch (e) {
			console.error(`${TAG} auto-open failed: ${e instanceof Error ? e.message : e}`);
		}
	});

	// Auto-close the run's terminal(s) once the run completes: kill makes
	// the finished dashboard disappear from the herdr UI, rm drops it from
	// the core. Covers the root binding and any chain-child inspectors of
	// the same run (keys `<runId>|…`).
	pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: unknown) => {
		try {
			if (!autocloseEnabled(process.env) || bindings.size === 0) return;
			const runId = asyncCompleteRunId(data);
			if (!runId) return; // unknown shape → ignore, like async-started
			const hcBin = resolveHcBin();
			if (!hcBin) return;
			const prefix = `${runId}|`;
			for (const key of [...bindings.keys()]) {
				if (!key.startsWith(prefix)) continue;
				const binding = bindings.get(key);
				bindings.delete(key);
				if (binding) closeBinding(hcBin, key, binding);
			}
		} catch (e) {
			console.error(`${TAG} autoclose failed: ${e instanceof Error ? e.message : e}`);
		}
	});

	// Register the inspector plugin once a session runs. pi-subagents
	// installs its registry listener at extension load time, so it is
	// already listening by the first session_start; re-registrations after
	// a shutdown would be rejected as duplicates, hence the guard.
	pi.on("session_start", async () => {
		if (registration || !extensionActive(process.env)) return;
		try {
			registration = registerInspectorPlugin(pi);
		} catch (e) {
			console.error(`${TAG} inspector registration failed: ${e instanceof Error ? e.message : e}`);
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			registration?.dispose();
		} catch (e) {
			console.warn(`${TAG} registration dispose: ${e instanceof Error ? e.message : e}`);
		}
		registration = undefined;
		// Close every still-tracked terminal: the inspectors of an ended
		// session must not linger in herdr-core.
		try {
			if (!autocloseEnabled(process.env) || bindings.size === 0) return;
			const hcBin = resolveHcBin();
			if (!hcBin) return;
			for (const [key, binding] of [...bindings]) {
				bindings.delete(key);
				closeBinding(hcBin, key, binding);
			}
		} catch (e) {
			console.error(`${TAG} shutdown autoclose failed: ${e instanceof Error ? e.message : e}`);
		}
	});
}
