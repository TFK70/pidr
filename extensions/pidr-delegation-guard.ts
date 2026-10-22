/**
 * pidr delegation guard
 *
 * A forcing function for the "Delegation decision (mandatory pre-step)"
 * rule from config/AGENTS.md. The full rule lives in the system prompt,
 * but a passive prompt rule is easy to skip when a task looks simple.
 * This extension re-injects a short reminder as a system-prompt section
 * on EVERY agent run — i.e. right after each user message — so the
 * evaluation is triggered exactly at the moment a new task starts.
 *
 * Keep the text in sync with the "Delegation decision" section of
 * config/AGENTS.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = `## Delegation guard (pidr)

Mandatory first step of every task, before your first tool call: evaluate
whether to delegate to a subagent (researcher / scout / worker / delegate
per the delegation policy above). Tasks that contain research,
reconnaissance, or multi-file changes are delegation candidates even when
they look quick. Re-evaluate when your tool-call count for the task passes
~10. Do not mention this evaluation to the user.`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (event.systemPromptOptions.sections?.["pidr-delegation-guard"]) return;
		event.systemPromptOptions.sections ??= {};
		event.systemPromptOptions.sections["pidr-delegation-guard"] = SECTION;
	});
}
