/**
 * Z.ai coding plan status footer
 *
 * Replaces the default footer with a minimal line showing only:
 *   current dir | model | thinking level | z.ai coding plan usage
 *
 * The z.ai API key is resolved in this order:
 *   1. ZAI_API_KEY / Z_AI_API_KEY env var
 *   2. ~/.pi/agent/auth.json entry with a provider id containing "zai"
 *      (supports pi's "!command" convention: the key is the output of a shell command)
 *
 * Usage data comes from https://api.z.ai/api/monitor/usage/quota/limit
 * (the same endpoint official z.ai tooling uses) and is refreshed every
 * 5 minutes, plus on demand via the /zai-usage command.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const REFRESH_MS = 5 * 60 * 1000;
const BASE_URL = "https://api.z.ai";

interface ZaiLimit {
	/** e.g. "5h" or "1mo" */
	window: string;
	used: number;
	total: number;
	percent: number;
	resetTime?: number;
}

interface ZaiUsage {
	limits: ZaiLimit[];
	level?: string;
	fetchedAt: number;
	error?: string;
}

function resolveApiKey(): string | undefined {
	const env = process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY;
	if (env) return env;
	try {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>;
		for (const [provider, entry] of Object.entries(auth)) {
			if (provider.toLowerCase().includes("zai") && entry.key) {
				if (entry.key.startsWith("!")) {
					try {
						return execSync(entry.key.slice(1), { encoding: "utf8", timeout: 5000 }).trim();
					} catch {
						return undefined;
					}
				}
				return entry.key;
			}
		}
	} catch {
		// no auth.json
	}
	return undefined;
}

async function fetchUsage(apiKey: string): Promise<ZaiUsage> {
	const now = Date.now();
	try {
		const res = await fetch(`${BASE_URL}/api/monitor/usage/quota/limit`, {
			headers: {
				Authorization: apiKey,
				"Accept-Language": "en-US,en",
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return parseQuota(await res.json(), now);
	} catch (e) {
		return { limits: [], fetchedAt: now, error: e instanceof Error ? e.message : "fetch failed" };
	}
}

const UNITS: Record<string, string> = {
	"3": "h",
	"4": "d",
	"5": "w",
	"6": "mo",
};

function parseQuota(body: any, now: number): ZaiUsage {
	const limits: any[] = body?.data?.limits ?? [];
	const out: ZaiLimit[] = [];
	for (const l of limits) {
		if (l?.type !== "CREDIT_LIMIT" && l?.type !== "TOKENS_LIMIT") continue;
		const unit = UNITS[String(l.unit)] ?? "";
		out.push({
			window: `${l.number}${unit}`,
			used: l.currentValue ?? l.usage ?? 0,
			total: l.usage ?? l.limit ?? 0,
			percent: Math.round(l.percentage ?? 0),
			resetTime: l.nextResetTime,
		});
	}
	return { limits: out, level: body?.data?.level, fetchedAt: now };
}

function formatReset(resetTime: number | undefined, now: number): string {
	if (!resetTime) return "";
	const ms = resetTime - now;
	if (ms <= 0) return " (now)";
	const min = Math.round(ms / 60000);
	if (min < 60) return ` (${min}m)`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	if (h < 24) return ` (${h}h${m ? `${m}m` : ""})`;
	const d = Math.floor(h / 24);
	return ` (${d}d${h % 24 ? `${h % 24}h` : ""})`;
}

function usageColor(percent: number): "success" | "warning" | "error" {
	return percent >= 90 ? "error" : percent >= 75 ? "warning" : "success";
}

export default function (pi: ExtensionAPI) {
	let usage: ZaiUsage | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let requestRender: (() => void) | undefined;

	async function refresh(apiKey: string) {
		usage = await fetchUsage(apiKey);
		if (usage.error) console.warn(`[zai-usage] ${usage.error}`);
		requestRender?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		const apiKey = resolveApiKey();
		if (!apiKey) {
			ctx.ui.setStatus?.("zai-usage", ctx.ui.theme.fg("error", "zai-usage: no API key (set ZAI_API_KEY)"));
			return;
		}

		if (ctx.mode === "tui" && ctx.ui.setFooter) {
			ctx.ui.setFooter((tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					dispose() {
						requestRender = undefined;
					},
					invalidate() {},
					render(width: number): string[] {
						try {
						const dir = ctx.cwd.replace(homedir(), "~");
						const model = ctx.model?.id ?? "no-model";
						const think = ctx.thinkingLevel ?? pi.getThinkingLevel?.() ?? "off";

						let zai: string;
						if (!usage) zai = theme.fg("dim", "z.ai: …");
						else if (usage.error) zai = theme.fg("error", "z.ai: ✗");
						else {
							const now = Date.now();
							const parts = usage.limits.map(
								(l) =>
									theme.fg(usageColor(l.percent), `${l.percent}%`) +
									theme.fg("dim", ` ${l.used}/${l.total} ${l.window}${formatReset(l.resetTime, now)}`),
							);
							const level = usage.level ? theme.fg("dim", ` (${usage.level})`) : "";
							zai = theme.fg("dim", "z.ai: ") + (parts.join(theme.fg("dim", " • ")) || "n/a") + level;
						}

						const left =
							theme.fg("dim", dir) +
							theme.fg("dim", " │ ") +
							theme.fg("accent", model) +
							theme.fg("dim", " │ ") +
							theme.fg("dim", `think: ${think}`);
						const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(zai)));
						return [truncateToWidth(left + pad + zai, width)];
						} catch (e) {
						// A footer bug must never crash pi; fall back to a plain line.
						console.warn(`[zai-usage] render error: ${e instanceof Error ? e.message : e}`);
						return ["z.ai footer error"];
						}
					},
				};
			});
		}

		refresh(apiKey); // initial fetch, fire and forget
		if (timer) clearInterval(timer);
		timer = setInterval(() => refresh(apiKey), REFRESH_MS);
		timer.unref?.();
	});

	pi.registerCommand("zai-usage", {
		description: "Refresh z.ai coding plan usage and show details",
		handler: async (_args, ctx) => {
			const apiKey = resolveApiKey();
			if (!apiKey) {
				ctx.ui.notify(
					"zai-usage: no API key found (set ZAI_API_KEY or add a zai entry to ~/.pi/agent/auth.json)",
					"error",
				);
				return;
			}
			usage = await fetchUsage(apiKey);
			requestRender?.();
			if (usage.error) {
				ctx.ui.notify(`z.ai usage: ${usage.error}`, "error");
				return;
			}
			const detail = usage.limits
				.map((l) => {
					const reset = l.resetTime ? ` (resets ${new Date(l.resetTime).toLocaleString()})` : "";
					return `${l.window}: ${l.percent}% used — ${l.used.toLocaleString()}/${l.total.toLocaleString()} credits${reset}`;
				})
				.join("\n");
			ctx.ui.notify(`Z.ai coding plan${usage.level ? ` (${usage.level})` : ""}:\n${detail}`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		requestRender = undefined;
	});
}
