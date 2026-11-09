/**
 * pidr mcp-memory MCP
 *
 * Registers the shared agent memory service (mcp-memory: statuses, research
 * results, agreements, infrastructure facts — shared between argus and pi) as
 * a streamable-HTTP MCP server for every session, without touching the
 * mutable ~/.pi/agent/mcp.json. Registrations are not persisted by pi, so
 * re-registering on every extension load is the intended pattern — the same
 * shape as pidr-mcp-kubernetes.
 *
 * The server needs two custom headers: Authorization (Bearer API key) and
 * X-Agent-ID (entries are auto-tagged `agent:<id>` by it). The API key must
 * not enter this repository or the Nix store: the Authorization header is the
 * environment reference `${PIDR_MCP_MEMORY_TOKEN}`, which pi resolves at
 * connect time from the environment pi runs in (a shell profile, or the
 * herdr/agent environment). Without the token the server is not registered —
 * a warning names the variable — because every request would be rejected as
 * unauthorized anyway. `pi mcp list` diagnoses the connection.
 *
 * The URL can be overridden with PIDR_MEMORY_MCP_URL, the agent id with
 * PIDR_MEMORY_MCP_AGENT_ID (default pi-agent, the convention the memory
 * service tags pi entries by). A mcp.json entry with the same name would take
 * precedence over this registration, which keeps an escape hatch for
 * per-user overrides.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SERVER_NAME = "memory";
const DEFAULT_URL = "https://mcp-memory.k8s.pukabos.xyz/mcp";
const TOKEN_ENV = "PIDR_MCP_MEMORY_TOKEN";
const DEFAULT_AGENT_ID = "pi-agent";

export default function (pi: ExtensionAPI) {
	if (!process.env[TOKEN_ENV]?.trim()) {
		console.warn(`[pidr-mcp-memory] ${TOKEN_ENV} is not set; the shared memory MCP server is not registered`);
		return;
	}
	const url = process.env.PIDR_MEMORY_MCP_URL || DEFAULT_URL;
	const agentId = process.env.PIDR_MEMORY_MCP_AGENT_ID || DEFAULT_AGENT_ID;
	try {
		pi.registerMcpServer(SERVER_NAME, {
			url,
			type: "http",
			headers: {
				Authorization: `Bearer \${${TOKEN_ENV}}`,
				"X-Agent-ID": agentId,
			},
			description:
				"Shared agent memory (mcp-memory): store and semantically search task outcomes, homelab state, user decisions and infrastructure facts shared across agents.",
		});
	} catch (e) {
		console.warn(`[pidr-mcp-memory] ${e instanceof Error ? e.message : e}`);
	}
}
