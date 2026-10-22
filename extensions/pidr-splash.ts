/**
 * pidr splash screen
 *
 * Shows a braille "pidr" logo — the π glyph from
 * emojicombos.com/pi-ascii-art with a lowercase "dr" appended on its
 * baseline in the same solid style — plus a one-glance startup summary:
 * active extensions and MCP servers with connection states, and a warning
 * when pi's own startup header is not silenced (quietStartup). Rendered as
 * a custom entry (never sent to the LLM).
 *
 * The splash is appended only for session_start with reason "startup", so
 * reload/resume/fork do not duplicate it. Extension names are the statically
 * known pidr bundle plus whatever settings.json declares (packages and
 * extensions); MCP names come from the mcp.json files and extension
 * registrations, and their states from a `pi mcp list --json` probe spawned
 * against pi's real entry script (the pidr wrapper's `-e` flags would turn a
 * plain `pi mcp list` into an agent prompt). The probe runs fire-and-forget
 * with a ~10s timeout; every external operation is wrapped so the splash can
 * never break startup.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";


const LOGO_MCQUEEN = [
	"⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⣀⣀⣀⡀⠀⢀⣀⠀",
	"⠀⠀⠀⠀⠀⠀⣠⠞⢛⡉⠁⣀⠀⠹⡁⢻⣿⣿⡄",
	"⠀⠀⣀⣀⣀⣴⣧⣤⣾⣷⣶⣿⣶⣾⣷⣾⣿⣿⡇",
	"⠠⠛⢻⣿⣿⣿⣿⣿⣿⣏⣥⣤⣿⡿⢿⣿⣿⡿⡇",
	"⣿⣿⣿⡉⠛⠛⠛⠉⠉⣠⣿⣿⣿⡇⠀⢹⣿⡇⡇",
	"⠻⣿⣿⣿⣶⣶⣶⣶⣿⣿⣿⣿⣿⠁⠀⣼⠿⠷⠃",
	"⠀⠈⠉⠉⠉⠉⠉⠁⠀⠀⠀⠙⠛⠛⠛⠁⠀⠀⠀",
];
// McQueen art rendered in red (normal 0;31 / bright 0;91), mirroring the
// ANSI styling previously used in the dr block.
const LOGO = LOGO_MCQUEEN.map((row) => `\u001b[0;91m${row}\u001b[0m`);
const LOGO_WIDTH = Math.max(...LOGO_MCQUEEN.map((row) => row.length));

type McpDisplayState = "ok" | "down" | "auth" | "off" | "?";

/** Summary persisted with the splash entry. */
interface PidrSplashData {
	extensions: string[];
	mcp: Array<{ name: string; state: McpDisplayState }>;
	/** pi's own startup header is not silenced (quietStartup !== true). */
	warnQuietStartup: boolean;
	/** pidr git revision injected as PIDR_REV by the Nix wrapper; null when
	 *  unset. Snapshotted so saved sessions keep the rev they started with. */
	pidrRev: string | null;
}

const MCP_MARK: Record<McpDisplayState, readonly [mark: string, color: Parameters<Theme["fg"]>[0]]> = {
	ok: ["✓", "success"],
	down: ["✗", "error"],
	auth: ["!", "warning"],
	off: ["off", "dim"],
	"?": ["?", "dim"],
};

/** pidr bundles these extensions statically; settings.json may declare more. */
function collectExtensions(pi: ExtensionAPI): string[] {
	const names = new Set<string>(["pidr-footer", "pidr-instructions", "pidr-delegation-guard", "pidr-splash", "pidr-mcp-kubernetes"]);
	try {
		const settings = pi.getSettings() as { packages?: unknown[]; extensions?: unknown[] };
		for (const source of [...(settings.packages ?? []), ...(settings.extensions ?? [])]) {
			const name = typeof source === "string" ? source : (source as { name?: unknown } | null)?.name;
			if (typeof name === "string" && name) names.add(name);
		}
	} catch {
		// settings unavailable; the static pidr list is still correct
	}
	return [...names];
}

/** MCP server names: user mcp.json, project .pi/mcp.json (trusted projects
 *  only, mirroring pi), then servers registered by extensions. */
function collectMcpNames(pi: ExtensionAPI, cwd: string, projectTrusted: boolean): string[] {
	const names: string[] = [];
	const files = [join(homedir(), ".pi", "agent", "mcp.json")];
	if (projectTrusted) files.push(join(cwd, ".pi", "mcp.json"));
	for (const file of files) {
		try {
			if (!existsSync(file)) continue;
			const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
			for (const name of Object.keys(config.mcpServers ?? {})) if (!names.includes(name)) names.push(name);
		} catch {
			// unreadable or invalid mcp.json; pi reports configuration errors itself
		}
	}
	try {
		for (const server of pi.getMcpServers()) if (!names.includes(server.name)) names.push(server.name);
	} catch {
		// no MCP registry available in this mode
	}
	return names;
}

interface McpReport {
	enabled: boolean;
	state: string;
}

/**
 * Probe MCP server states with `pi mcp list --json`. Spawned against
 * process.argv[1] (pi's entry script) rather than the `pi` on PATH, because
 * the pidr wrapper prepends -e flags that swallow the subcommand. Returns an
 * empty map when the probe fails or times out; callers then show "?".
 */
async function probeMcpStates(cwd: string): Promise<Map<string, McpReport>> {
	const reports = new Map<string, McpReport>();
	const entry = process.argv[1];
	if (!entry || !/\.(?:js|mjs|cjs)$/.test(entry)) return reports;
	try {
		const child = spawn(process.execPath, [entry, "mcp", "list", "--json"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		});
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
		await new Promise<void>((resolve) => {
			child.once("error", () => resolve());
			child.once("close", () => resolve());
		});
		const parsed = JSON.parse(stdout) as {
			servers?: Array<{ name?: unknown; enabled?: boolean; state?: unknown }>;
		};
		for (const server of parsed.servers ?? []) {
			if (typeof server.name !== "string") continue;
			reports.set(server.name, {
				enabled: server.enabled !== false,
				state: typeof server.state === "string" ? server.state : "",
			});
		}
	} catch {
		// probe failed or timed out; every state stays unknown
	}
	return reports;
}

function displayState(report: McpReport | undefined): McpDisplayState {
	if (!report) return "?";
	if (!report.enabled) return "off";
	switch (report.state) {
		case "connected":
			return "ok";
		case "failed":
		case "disconnected":
			return "down";
		case "needs-auth":
			return "auth";
		default: // connecting, closed, anything unrecognized
			return "?";
	}
}

/** Whether pi's own startup header is silenced (settings `quietStartup`).
 *  "header" still prints the version header, so only `true` counts. */
function isQuietStartup(pi: ExtensionAPI): boolean {
	try {
		const settings = pi.getSettings() as { quietStartup?: unknown };
		return settings.quietStartup === true;
	} catch {
		// getSettings unavailable; peek at the global settings file read-only.
		try {
			const file = join(homedir(), ".pi", "agent", "settings.json");
			if (existsSync(file)) {
				const raw = JSON.parse(readFileSync(file, "utf8")) as { quietStartup?: unknown };
				return raw.quietStartup === true;
			}
		} catch {
			// unreadable or invalid; assume the default (header shown)
		}
		return false;
	}
}

function splashLines(data: PidrSplashData, theme: Theme): string[] {
	// Rows with embedded ANSI colors (mcqueen, dr) keep their own colors;
	// plain braille rows get the theme accent.
	const art = LOGO.map((row) => (row.includes("\u001b") ? row : theme.fg("accent", row)));
	const rule = theme.fg("dim", "─".repeat(LOGO_WIDTH));
	const dim = (text: string) => theme.fg("dim", text);
	const extensions =
		dim("ext: ") + (data.extensions.length ? data.extensions.join(dim(" · ")) : dim("нет"));
	const mcpParts = data.mcp.map(({ name, state }) => {
		const [mark, color] = MCP_MARK[state];
		return `${name} ${theme.fg(color, mark)}`;
	});
	const mcp = dim("mcp: ") + (mcpParts.length ? mcpParts.join(dim(" · ")) : dim("нет"));
	const lines = ["", ...art, "", rule];
	if (data.pidrRev !== null) {
		// PIDR_REV is either a clean git rev or "<rev>-dirty"; strip the
		// dirty suffix and shorten to the usual 7-char form.
		const shown = data.pidrRev.replace(/-dirty$/, "").slice(0, 7);
		lines.push(dim("pidr: ") + theme.fg("warning", shown));
	}
	lines.push(extensions, mcp);
	if (data.warnQuietStartup) {
		lines.push(
			theme.fg(
				"warning",
				"⚠ заголовок pi не отключён (quietStartup ≠ true): выполните /settings → Quiet startup → true",
			),
		);
	}
	lines.push("");
	return lines;
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<PidrSplashData>("pidr-splash", (entry, _options, theme) => {
		if (!entry.data) return undefined;
		try {
			return new Text(splashLines(entry.data, theme).join("\n"), 0, 0);
		} catch (e) {
			console.warn(`[pidr-splash] render error: ${e instanceof Error ? e.message : e}`);
			return undefined;
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		// Fire-and-forget: the MCP probe must not block startup, and the
		// splash must never break the session it decorates.
		void (async () => {
			try {
				const extensions = collectExtensions(pi);
				const mcpNames = collectMcpNames(pi, ctx.cwd, ctx.isProjectTrusted());
				const reports = await probeMcpStates(ctx.cwd);
				pi.appendEntry<PidrSplashData>("pidr-splash", {
					extensions,
					mcp: mcpNames.map((name) => ({ name, state: displayState(reports.get(name)) })),
					warnQuietStartup: !isQuietStartup(pi),
					pidrRev: process.env.PIDR_REV ?? null,
				});
			} catch (e) {
				console.warn(`[pidr-splash] ${e instanceof Error ? e.message : e}`);
			}
		})();
	});
}
