/**
 * pidr herdr-core subagent visibility
 *
 * pi-subagents background runs are invisible to the new-generation herdr
 * app (herdr-core, CLI `hc`): herdr-core only tracks terminals it started
 * itself, and async subagents spawn as detached processes. This extension
 * gives them a face in the herdr UI without touching pi-subagents:
 *
 * - auto-open: on the pi-subagents `subagent:async-started` event, start
 *   `<hc> run --bg --name pi-sub-<alias> -- node <PI_SUBAGENTS_DIR>/inspector-runner.mjs
 *   --async-dir <dir> --run-id <id> --refresh-ms 1000` behind this
 *   directory's monitor — a live read-only transcript terminal parented to
 *   pi's own herdr terminal (`--parent` defaults to the launching terminal,
 *   which inside herdr is the pi panel). The alias is human-readable and
 *   taken from the id the caller passed to subagent() (tracked from the
 *   spawning tool call), the workflow key / custom id the run was launched
 *   under, or the agent name (see runAlias) — never the raw run UUID.
 * - transcript + status: herdr-subagent-monitor.mjs (loaded in place from
 *   this flake source directory) renders the run's session JSONL with pi's
 *   own TUI components (roles, thinking blocks, tool call/result blocks,
 *   diff highlighting, theme — same look as the pi chat), tailing it live,
 *   and translates `<asyncDir>/status.json` into the terminal's root
 *   OSC 7501 status (`state=…:app=pi-subagents:title=…`). The pi package
 *   for that rendering is resolved from PIDR_PI_PACKAGE_DIR (set by the
 *   Nix wrapper) and passed as --pi-package-dir; without it the monitor
 *   degrades to the classic plain-text inspector dashboard. herdr also
 *   derives the parent's status from these terminals (a parent takes its
 *   most urgent sub-agent's place) — nothing extra is needed here for
 *   that.
 * - auto-close: on `subagent:async-complete` the run's terminal is closed
 *   fire-and-forget (`<hc> kill <address-or-name>` makes it finished,
 *   `<hc> rm <addr>` drops it from the core), and `session_shutdown`
 *   closes every still-tracked terminal so inspectors of an ended session
 *   do not linger. PIDR_HERDR_AUTOCLOSE=0 keeps them open instead. As a net
 *   for sessions that died before closing (OOM-kill, crash), the first
 *   session_start sweeps monitor terminals of finished runs: monitors are
 *   spawned with a `pidr-run=<runId>` label, and every async run in a
 *   terminal state older than a few minutes gets its labelled terminals
 *   killed and removed. The monitor itself also exits once its run reaches
 *   a terminal state (see herdr-subagent-monitor.mjs), so orphans cannot
 *   outlive their runs by more than a grace period.
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
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
 *  unique among live terminals. Named after the run's human-readable alias
 *  (see runAlias) — the alias must fit plus a sanitized suffix. */
const NAME_PREFIX = "pi-sub-";
const NAME_MAX = 32;
const SHORT_ID_LEN = 6;

/** Payload of `subagent:async-started` — only the fields used here. The
 *  event carries no explicit "requested id" field: plain subagent() launches
 *  always get a UUID run id and pi-subagents never persists the caller's
 *  top-level `id` param. The requested id is instead recovered from the
 *  spawning tool call (see requestedAliasFor): the single-mode emission
 *  carries `toolCallId`, matched against `tool_execution_start` args. Other
 *  human-readable fields: workflow children (runs.run(key, …)) report their
 *  key as `workflowKey`, mission-bound children run under a custom non-UUID
 *  id, and `agent` is the first agent's name. */
interface AsyncStartedRun {
	id: string;
	asyncDir: string;
	cwd?: string;
	agent?: string;
	workflowKey?: string;
	toolCallId?: string;
}

/** Minimal restatement of pi-subagents' inspector contracts
 *  (src/inspectors/types.d.ts, v0.80.0) — only what this file implements. */
interface InspectorTarget {
	runId: string;
	asyncDir: string;
	index?: number;
	status: { cwd?: string; state: string; agent?: string; workflowKey?: string };
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

/** The `id` (or `runId`) param of in-flight subagent() tool calls, keyed by
 *  the call's toolCallId — the only place pi-subagents ever sees the
 *  caller-requested id (it is not persisted in the run's artifacts and not
 *  emitted in subagent:async-started). Bounded; entries are dropped when the
 *  call ends. */
const requestedIds = new Map<string, string>();
const REQUESTED_IDS_MAX = 64;

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

/** The pi package whose TUI components the monitor renders transcripts
 *  with (path injected by the Nix wrapper via PIDR_PI_PACKAGE_DIR). Missing
 *  → undefined: the monitor then degrades to the classic dashboard. */
function piPackageDir(): string | undefined {
	const dir = process.env.PIDR_PI_PACKAGE_DIR?.trim();
	if (!dir) return undefined;
	try {
		return existsSync(join(dir, "dist", "index.js")) ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** Command prefix running the inspector behind the status monitor:
 *  `node <monitor> --runner <inspector-runner> [--pi-package-dir <dir>]`;
 *  without a monitor, the bare `node <inspector-runner>` (reported once,
 *  then silent). */
function inspectorCommandPrefix(runner: string): string[] {
	const monitor = monitorPath();
	if (!monitor) {
		console.error(
			`${TAG} herdr-subagent-monitor.mjs not found next to the extension; inspector terminals will not report status`,
		);
		return [process.execPath, runner];
	}
	const prefix = [process.execPath, monitor, "--runner", runner];
	const piDir = piPackageDir();
	if (piDir) prefix.push("--pi-package-dir", piDir);
	return prefix;
}

/** Wrap a pi-subagents inspector launch (executable + argv, argv[0] being
 *  the inspector-runner) the same way: run the monitor in front. */
function wrapLaunchCommand(launch: InspectorLaunch): string[] {
	const monitor = monitorPath();
	if (!monitor || launch.argv.length === 0) return [launch.executable, ...launch.argv];
	const wrapped = [launch.executable, monitor, "--runner", launch.argv[0]];
	const piDir = piPackageDir();
	if (piDir) wrapped.push("--pi-package-dir", piDir);
	wrapped.push(...launch.argv.slice(1));
	return wrapped;
}

/** Binding key: run id plus the child index of a chain step (the root
 *  inspector of a run has none). */
function targetKey(runId: string, index: number | undefined): string {
	return `${runId}|${index ?? ""}`;
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
	/** Second name to try when `name` clashes with a live terminal. */
	fallbackName?: string;
	/** herdr-core terminal labels (`--label k=v`): let the orphan sweep find
	 *  the terminal of a run without guessing from its display name. */
	labels?: Record<string, string>;
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
	for (const [key, value] of Object.entries(launch.labels ?? {})) args.push("--label", `${key}=${value}`);
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
 *  spawn a duplicate), retried with the fallback name when the chosen name
 *  clashes with a live terminal (two runs can share an alias), then with no
 *  name at all (herdr-core assigns one), and rolled back when the terminal
 *  never starts. On success the binding keeps the terminal address from the
 *  run output — auto-close targets it before the name. */
function openTrackedInspectorTerminal(open: TrackedOpen): void {
	bindings.set(open.key, { name: open.name ?? null });
	const attempt = (name: string | undefined) => {
		launchInspectorTerminal(
			open.hcBin,
			{ name, labels: open.labels, cwd: open.cwd, command: open.command, signal: open.signal },
			(ok, detail, runStdout) => {
				if (!ok && name !== undefined && !open.signal?.aborted) {
					// The name is taken by a live terminal (e.g. a parallel run
					// with the same alias, or a leftover inspector from an
					// earlier pi session): try the discriminated fallback name,
					// then let herdr-core assign its own name.
					const next = name === open.name ? open.fallbackName : undefined;
					bindings.set(open.key, { name: next ?? null });
					attempt(next);
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
	const event = data as {
		id?: unknown;
		asyncDir?: unknown;
		cwd?: unknown;
		agent?: unknown;
		workflowKey?: unknown;
		toolCallId?: unknown;
	};
	if (typeof event.id !== "string" || !event.id) return undefined;
	if (typeof event.asyncDir !== "string" || !event.asyncDir) return undefined;
	return {
		id: event.id,
		asyncDir: event.asyncDir,
		...(typeof event.cwd === "string" && event.cwd ? { cwd: event.cwd } : {}),
		...(typeof event.agent === "string" && event.agent ? { agent: event.agent } : {}),
		...(typeof event.workflowKey === "string" && event.workflowKey ? { workflowKey: event.workflowKey } : {}),
		...(typeof event.toolCallId === "string" && event.toolCallId ? { toolCallId: event.toolCallId } : {}),
	};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id the caller passed to subagent() for the tool call that spawned this
 *  run, when that call is still tracked; a plain UUID id carries no display
 *  value (it is just a generated run id), so it is ignored like a UUID run
 *  id in runAlias(). */
function requestedAliasFor(run: AsyncStartedRun): string | undefined {
	const requested = run.toolCallId !== undefined ? requestedIds.get(run.toolCallId) : undefined;
	const id = requested?.trim();
	return id && !UUID_RE.test(id) ? id : undefined;
}

/** Human-readable alias for a run: the id the caller passed to subagent()
 *  (tracked from the tool call), else the workflow key (runs.run(key, …)),
 *  else a custom non-UUID run id (mission-bound children), else the agent
 *  name, else a short id prefix. */
function runAlias(run: AsyncStartedRun): string {
	const requested = requestedAliasFor(run);
	if (requested) return requested;
	const workflowKey = run.workflowKey?.trim();
	if (workflowKey) return workflowKey;
	if (!UUID_RE.test(run.id)) return run.id;
	return run.agent?.trim() || run.id.slice(0, SHORT_ID_LEN);
}

/** Alias for an inspector target (no event payload there): the workflow key
 *  or agent name recorded in the run's status.json, else a short id prefix. */
function targetAlias(target: InspectorTarget): string {
	const workflowKey = target.status.workflowKey?.trim();
	if (workflowKey) return workflowKey;
	return target.status.agent?.trim() || target.runId.slice(0, SHORT_ID_LEN);
}

/** `pi-sub-<sanitized alias>` inside herdr-core's 32-char a-z0-9-_ name
 *  budget; a child inspector of a chain run also carries its step index. */
function terminalName(alias: string, index?: number): string {
	const suffix = index === undefined ? "" : `-${index}`;
	const budget = NAME_MAX - NAME_PREFIX.length - suffix.length;
	const slug = alias
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, Math.max(0, budget));
	return NAME_PREFIX + (slug || "run") + suffix;
}

/** Terminal names for one run: the pretty alias, and the same alias plus a
 *  short run-id suffix as the clash fallback (the alias is pre-truncated so
 *  the discriminator always survives the 32-char budget). */
function terminalNames(
	alias: string,
	runId: string,
	index?: number,
): { name: string; fallbackName: string } {
	const suffixLen = index === undefined ? 0 : String(index).length + 1;
	const budget = Math.max(0, NAME_MAX - NAME_PREFIX.length - suffixLen - (1 + SHORT_ID_LEN));
	const short = alias.length > budget ? alias.slice(0, budget) : alias;
	return {
		name: terminalName(alias, index),
		fallbackName: terminalName(`${short}-${runId.slice(0, SHORT_ID_LEN)}`, index),
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
			const alias = targetAlias(context.target);
			const names = terminalNames(alias, context.target.runId, context.target.index);
			const [ok, detail, usedName] = await new Promise<[boolean, string, string | undefined]>(
				(resolve) => {
					openTrackedInspectorTerminal({
						hcBin,
						key,
						name: names.name,
						fallbackName: names.fallbackName,
						cwd: context.target.status.cwd ?? context.cwd,
						labels: { "pidr-run": context.target.runId },
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

/** Terminal states whose monitor terminals the orphan sweep may close. */
const SWEEP_TERMINAL_STATES = new Set(["complete", "failed", "partial", "rejected", "stopped"]);
/** A finished run younger than this may still be closed by its live parent's
 *  auto-close; the sweep must not race it. */
const SWEEP_MIN_AGE_MS = 5 * 60_000;
/** Bounds for the sweep: run directories examined and hc queries issued. */
const SWEEP_MAX_RUNS = 100;

/** The async-runs root, mirroring pi-subagents' TEMP_ROOT_DIR formula
 *  (src/shared/types.js): PI_SUBAGENTS_TEMP_ROOT override, else
 *  `<tmpdir>/pi-subagents-uid-<uid>`. */
function asyncRunsRoot(): string {
	const override = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (override) return override;
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return join(tmpdir(), `pi-subagents-uid-${uid}`);
}

interface SweptRun {
	runId: string;
	state: string;
}

/** Terminal-state async runs old enough that no live parent is still about
 *  to close their terminals. Bounded; read-only on failure. */
function collectSweepableRuns(): SweptRun[] {
	const runs: SweptRun[] = [];
	let entries: string[];
	try {
		entries = readdirSync(join(asyncRunsRoot(), "async-subagent-runs"));
	} catch {
		return runs; // no runs directory (or unreadable): nothing to sweep
	}
	const now = Date.now();
	for (const entry of entries.slice(0, SWEEP_MAX_RUNS)) {
		try {
			const status = JSON.parse(readFileSync(join(asyncRunsRoot(), "async-subagent-runs", entry, "status.json"), "utf8")) as {
				runId?: unknown;
				state?: unknown;
				endedAt?: unknown;
			};
			if (typeof status.runId !== "string" || !SWEEP_TERMINAL_STATES.has(String(status.state))) continue;
			// no endedAt (torn write) → treat as old: the state is terminal
			const age = typeof status.endedAt === "number" ? now - status.endedAt : Number.POSITIVE_INFINITY;
			if (age < SWEEP_MIN_AGE_MS) continue;
			runs.push({ runId: status.runId, state: String(status.state) });
		} catch {
			// unreadable or torn status.json: not sweepable
		}
	}
	return runs;
}

/** Close every live herdr terminal labelled for one of the finished runs —
 *  the monitors of runs whose parent session died before auto-closing them
 *  (OOM-kill, crash). Fire-and-forget, bounded, best-effort: `hc ls --label
 *  pidr-run=<id>` finds exactly our terminals, `kill`+`rm` closes them. */
function sweepOrphanMonitorTerminals(hcBin: string): void {
	try {
		const runs = collectSweepableRuns();
		for (const run of runs) {
			let stdout = "";
			const child = spawn(hcBin, ["ls", "--json", "--label", `pidr-run=${run.runId}`], {
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 10_000,
			});
			child.stdout?.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-65536)));
			child.once("error", () => {});
			child.once("close", () => {
				try {
					const parsed = JSON.parse(stdout) as { terminals?: Array<{ address?: unknown; state?: unknown }> };
					for (const terminal of parsed.terminals ?? []) {
						if (typeof terminal.address !== "string" || terminal.state !== "live") continue;
						console.warn(`${TAG} sweeping orphan monitor terminal ${terminal.address} (run ${run.runId} is ${run.state})`);
						closeInspectorTerminal(hcBin, terminal.address);
					}
				} catch {
					// malformed ls output: skip this run
				}
			});
		}
	} catch (e) {
		console.warn(`${TAG} orphan sweep failed: ${e instanceof Error ? e.message : e}`);
	}
}

export default function (pi: ExtensionAPI) {
	// Track the caller-requested id of in-flight subagent() calls: pi-subagents
	// never persists or emits that id, but the spawning tool call's args carry
	// it and subagent:async-started (single mode) reports the call's toolCallId.
	// Without this, a subagent({ id: "live-check", … }) launch can only be named
	// after its agent (pi-sub-worker), not pi-sub-live-check.
	pi.on("tool_execution_start", async (event: { toolName?: string; toolCallId?: string; args?: unknown }) => {
		try {
			if (event.toolName !== "subagent" || typeof event.toolCallId !== "string" || !event.toolCallId) return;
			const args = event.args;
			if (typeof args !== "object" || args === null) return;
			const requested = (args as { id?: unknown; runId?: unknown }).id ?? (args as { runId?: unknown }).runId;
			if (typeof requested !== "string" || !requested.trim()) return;
			requestedIds.set(event.toolCallId, requested);
			while (requestedIds.size > REQUESTED_IDS_MAX) {
				const oldest = requestedIds.keys().next().value;
				if (oldest === undefined) break;
				requestedIds.delete(oldest);
			}
		} catch {
			// tracking must never affect the tool call
		}
	});
	pi.on("tool_execution_end", async (event: { toolCallId?: string }) => {
		if (typeof event.toolCallId === "string") requestedIds.delete(event.toolCallId);
	});

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
			const names = terminalNames(runAlias(run), run.id, undefined);
			openTrackedInspectorTerminal({
				hcBin,
				key: targetKey(run.id, undefined),
				name: names.name,
				fallbackName: names.fallbackName,
				labels: { "pidr-run": run.id },
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
	// a shutdown would be rejected as duplicates, hence the guard. The same
	// first session_start sweeps monitor terminals orphaned by earlier pi
	// sessions that died (OOM-kill, crash) before auto-closing them.
	let swept = false;
	pi.on("session_start", async () => {
		if (!extensionActive(process.env)) return;
		if (!registration) {
			try {
				registration = registerInspectorPlugin(pi);
			} catch (e) {
				console.error(`${TAG} inspector registration failed: ${e instanceof Error ? e.message : e}`);
			}
		}
		if (swept || !autocloseEnabled(process.env)) return;
		swept = true;
		const hcBin = resolveHcBin();
		if (hcBin) sweepOrphanMonitorTerminals(hcBin);
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
