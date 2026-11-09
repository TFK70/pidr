/**
 * "Needs you" terminal status while ask_user_question waits for the user.
 *
 * pi already reports its program status to the terminal (OSC 7501, see pi's
 * ProgramStatusReporter): `working` during agent runs, `blocked` while its
 * own dialogs (settings, selectors, login) wait for the user, then
 * `done`/`idle`. herdr shows `blocked` as "needs you" in its agents sidebar
 * (blocked > done > working > idle), so a terminal waiting on the user sorts
 * to the top instead of looking busy.
 *
 * The gap: the ask_user_question tool (pidr's patched askuserquestion
 * extension) shows its question via `ctx.ui.custom(...)`, and custom
 * extension components are pushed onto the dialog stack WITHOUT a blocked
 * status — pi keeps reporting `working` while the question sits unanswered.
 *
 * This extension closes the gap from the outside, without patching pi:
 * on `tool_execution_start` for `ask_user_question` it writes the very same
 * OSC 7501 sequence pi itself would write (`state=blocked:kind=question:
 * app=pi:msg=<first question>`, built with pi-tui's formatProgramStatus),
 * and on `tool_execution_end` restores `state=working` — the agent run is
 * still active right after a tool completes, and pi's own reporter takes
 * over again on its next event (message_end / agent_settled), so no state
 * gets stuck. Event ordering guarantees that restore: pi settles the agent
 * turn only after the tool's execute() promise settles, i.e. after
 * tool_execution_end.
 *
 * Only writes when it has something to say (first open question → blocked,
 * last closed → working once); pi's own reports win outside that window.
 * Gated to herdr-core terminals (HC_TERMINAL_ID / HC_TERMINAL_SOCKET, the
 * same environment pidr-herdr-subagents gates on) because that is where the
 * status is consumed — plain terminals that never confirmed OSC 7501 support
 * are left untouched, matching pi's own support check. PIDR_HERDR_NEEDS_YOU=0
 * disables the extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatProgramStatus, type ProgramStatus } from "@earendil-works/pi-tui";

const TAG = "[pidr-herdr-needs-you]";

const TOOL_NAME = "ask_user_question";
/** The app name pi itself reports (pi's APP_NAME). */
const APP = "pi";

/** Inside a herdr-core terminal, programs receive HC_TERMINAL_ID and
 *  HC_TERMINAL_SOCKET; outside herdr neither exists. */
function insideHerdrCore(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.HC_TERMINAL_ID?.trim() || env.HC_TERMINAL_SOCKET?.trim());
}

/** First question text of an ask_user_question call, for the status message. */
function firstQuestionText(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const questions = (args as { questions?: unknown }).questions;
	if (!Array.isArray(questions)) return "";
	for (const question of questions) {
		if (typeof question !== "object" || question === null) continue;
		const text = (question as { question?: unknown }).question;
		if (typeof text === "string" && text.trim()) return text.trim();
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	const active = process.env.PIDR_HERDR_NEEDS_YOU !== "0" && insideHerdrCore(process.env);
	if (!active) return;

	/** Open ask_user_question calls by tool call id → first question text. */
	const open = new Map<string, string>();
	/** Whether our blocked status is currently on the wire (restores once). */
	let blockedReported = false;

	const write = (status: ProgramStatus) => {
		try {
			process.stdout.write(formatProgramStatus(status));
		} catch {
			// stdout is gone: status reporting is best-effort
		}
	};

	const sync = () => {
		const question = open.size > 0 ? open.values().next().value : undefined;
		if (question !== undefined) {
			write({
				state: "blocked",
				kind: "question",
				app: APP,
				...(question ? { message: question } : {}),
			});
			blockedReported = true;
			return;
		}
		if (!blockedReported) return;
		// The tool just completed inside a still-running agent turn; pi's own
		// reporter re-reports its real state on the next session event.
		write({ state: "working", app: APP });
		blockedReported = false;
	};

	pi.on("tool_execution_start", async (event: { toolName?: string; toolCallId?: string; args?: unknown }) => {
		try {
			if (event.toolName !== TOOL_NAME || typeof event.toolCallId !== "string") return;
			open.set(event.toolCallId, firstQuestionText(event.args));
			sync();
		} catch (e) {
			console.error(`${TAG} failed: ${e instanceof Error ? e.message : e}`);
		}
	});

	pi.on("tool_execution_end", async (event: { toolCallId?: string }) => {
		if (typeof event.toolCallId === "string" && open.delete(event.toolCallId)) sync();
	});

	pi.on("session_shutdown", async () => {
		// pi clears its own status on shutdown; forget ours so a session
		// switch cannot restore a stale working state.
		open.clear();
		blockedReported = false;
	});
}
