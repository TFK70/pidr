/**
 * claude-bridge — expose Claude Code project configuration to pi.
 *
 * For the git root of the current working directory (only when the project is
 * trusted):
 * - MCP servers from `.mcp.json` and `.claude/mcp.json` are registered with
 *   `pi.registerMcpServer()`. stdio (`command`/`args`/`env`/`cwd`) and
 *   streamable-http (`url`/`headers`) entries are supported; `type: "sse"` is
 *   rejected by pi and skipped. A same-name entry from `.claude/mcp.json`
 *   overrides `.mcp.json`; an override without `command`/`url`/`type` only
 *   adjusts fields of the entry it overrides (pi `mcp.json` semantics).
 * - `.claude/skills` is returned as a skill path from `resources_discover`;
 *   pi scans it recursively for `SKILL.md` files.
 * - `CLAUDE.md` is injected as the `claude_md` section of the system prompt,
 *   unless pi already loaded the same file as a native context file (pi reads
 *   CLAUDE.md itself when no AGENTS.md in the same directory shadows it).
 *
 * Registrations are per session and redone on every session load.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";

const TAG = "[claude-bridge]";

function warn(message: string, error?: unknown): void {
	const detail =
		error === undefined
			? ""
			: error instanceof Error
				? error.message
				: String(error);
	console.warn(detail ? `${TAG} ${message}: ${detail}` : `${TAG} ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") result[key] = entry;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Git root above `startDir`, marked by a `.git` entry (a file for worktrees),
 * or `startDir` itself when no repository encloses it.
 */
function findGitRoot(startDir: string): string {
	const resolved = path.resolve(startDir);
	let current = resolved;
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return resolved;
		current = parent;
	}
}

interface BridgeState {
	root: string;
	/** Absolute `.claude/skills` directory, when it exists. */
	skillsDir: string | undefined;
	/** Non-empty `CLAUDE.md` content, when it exists. */
	claudeMd: string | undefined;
	mcpServers: Map<string, McpServerConfig>;
}

/** Convert one Claude `mcpServers` entry to a pi config, or undefined when unusable. */
function toMcpServerConfig(name: string, entry: Record<string, unknown>): McpServerConfig | undefined {
	const type = typeof entry.type === "string" ? entry.type : undefined;
	if (type === "sse") {
		warn(`skipping MCP server "${name}": pi does not support the sse transport`);
		return undefined;
	}
	const common = {
		...(typeof entry.description === "string" ? { description: entry.description } : {}),
		...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
		...(entry.enabled === false ? { enabled: false } : {}),
	};
	if (type === "http" || type === "streamable-http" || (!type && typeof entry.url === "string")) {
		if (typeof entry.url !== "string") {
			warn(`skipping MCP server "${name}": http entry without url`);
			return undefined;
		}
		return { type: "http", url: entry.url, headers: stringRecord(entry.headers), ...common };
	}
	if (type === "stdio" || (!type && typeof entry.command === "string")) {
		if (typeof entry.command !== "string") {
			warn(`skipping MCP server "${name}": stdio entry without command`);
			return undefined;
		}
		return {
			type: "stdio",
			command: entry.command,
			...(Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string")
				? { args: entry.args as string[] }
				: {}),
			env: stringRecord(entry.env),
			...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
			...common,
		};
	}
	warn(`skipping MCP server "${name}": no command or url`);
	return undefined;
}

/**
 * Merge one mcp.json file into `entries`. Later files (`.claude/mcp.json`)
 * override same-name entries; a bare override without `command`/`url`/`type`
 * keeps the transport of the entry it overrides.
 */
function readMcpFile(file: string, entries: Map<string, Record<string, unknown>>): void {
	let parsed: unknown;
	try {
		if (!fs.existsSync(file)) return;
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (error) {
		warn(`failed to read ${file}`, error);
		return;
	}
	const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
	if (!isRecord(servers)) return;
	for (const [name, entry] of Object.entries(servers)) {
		if (!isRecord(entry)) {
			warn(`ignoring MCP server "${name}" in ${file}: not an object`);
			continue;
		}
		const base = entries.get(name);
		entries.set(name, base ? { ...base, ...entry } : entry);
	}
}

function resolveState(cwd: string): BridgeState {
	const root = findGitRoot(cwd);

	const rawEntries = new Map<string, Record<string, unknown>>();
	readMcpFile(path.join(root, ".mcp.json"), rawEntries);
	readMcpFile(path.join(root, ".claude", "mcp.json"), rawEntries);
	const mcpServers = new Map<string, McpServerConfig>();
	for (const [name, entry] of rawEntries) {
		const config = toMcpServerConfig(name, entry);
		if (config) mcpServers.set(name, config);
	}

	const skillsDir = path.join(root, ".claude", "skills");

	const claudeMdPath = path.join(root, "CLAUDE.md");
	let claudeMd: string | undefined;
	if (fs.existsSync(claudeMdPath)) {
		try {
			const content = fs.readFileSync(claudeMdPath, "utf-8");
			if (content.trim().length > 0) claudeMd = content;
		} catch (error) {
			warn(`failed to read ${claudeMdPath}`, error);
		}
	}

	return {
		root,
		skillsDir: fs.existsSync(skillsDir) ? skillsDir : undefined,
		claudeMd,
		mcpServers,
	};
}

export default function claudeBridge(pi: ExtensionAPI) {
	let state: BridgeState | undefined;
	/** MCP server names this extension registered in the current runtime. */
	const registered = new Set<string>();

	function currentState(cwd: string): BridgeState {
		if (state === undefined) state = resolveState(cwd);
		return state;
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			if (!ctx.isProjectTrusted()) {
				for (const name of registered) pi.unregisterMcpServer(name);
				registered.clear();
				state = undefined;
				return;
			}
			state = resolveState(ctx.cwd);
			for (const name of registered) {
				if (!state.mcpServers.has(name)) {
					pi.unregisterMcpServer(name);
					registered.delete(name);
				}
			}
			for (const [name, config] of state.mcpServers) {
				try {
					// Re-registering our own name replaces the earlier registration.
					pi.registerMcpServer(name, config);
					registered.add(name);
				} catch (error) {
					warn(`failed to register MCP server "${name}"`, error);
				}
			}
		} catch (error) {
			warn("session_start failed", error);
		}
	});

	pi.on("resources_discover", async (event, ctx) => {
		try {
			if (!ctx.isProjectTrusted()) return undefined;
			// session_start has usually resolved this already; avoid duplicate warnings.
			if (state === undefined || findGitRoot(event.cwd) !== state.root) {
				state = resolveState(event.cwd);
			}
			return state.skillsDir ? { skillPaths: [state.skillsDir] } : undefined;
		} catch (error) {
			warn("resources_discover failed", error);
			return undefined;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!ctx.isProjectTrusted()) return;
			const current = currentState(ctx.cwd);
			if (!current.claudeMd) return;
			const claudeMdPath = path.join(current.root, "CLAUDE.md");
			// pi loads CLAUDE.md as a context file unless an AGENTS.md in the same
			// directory shadows it; do not inject the same content twice.
			const alreadyLoaded = event.systemPromptOptions.contextFiles.some(
				(file) => path.resolve(file.path) === claudeMdPath,
			);
			if (alreadyLoaded) return;
			event.systemPromptOptions.sections["claude_md"] =
				`CLAUDE.md project instructions (${claudeMdPath}):\n\n${current.claudeMd.trimEnd()}`;
		} catch (error) {
			warn("failed to inject CLAUDE.md", error);
		}
	});
}
