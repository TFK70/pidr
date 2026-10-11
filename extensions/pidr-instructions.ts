/**
 * pidr global instructions
 *
 * Injects the repo's config/AGENTS.md into the system prompt as an
 * XML-wrapped <pidr-global-instructions> section on every agent run. This
 * keeps the global instructions declarative and portable: they ship with the
 * pidr wrapper via `-e` flags, with no home-manager or ~/.pi/agent files
 * required.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INSTRUCTIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "AGENTS.md");

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (event.systemPromptOptions.sections?.["pidr-global-instructions"]) return;
		try {
			const text = readFileSync(INSTRUCTIONS_PATH, "utf8").trim();
			if (!text) return;
			event.systemPromptOptions.sections ??= {};
			event.systemPromptOptions.sections["pidr-global-instructions"] = text;
		} catch (e) {
			console.warn(
				`[pidr-instructions] cannot read ${INSTRUCTIONS_PATH}: ${e instanceof Error ? e.message : e}`,
			);
		}
	});
}
