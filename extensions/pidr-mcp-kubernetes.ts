/**
 * pidr Kubernetes MCP
 *
 * Registers the homelab kubernetes-mcp-server (streamable HTTP behind the
 * cluster ingress) as an MCP server for every session, without touching
 * the mutable ~/.pi/agent/mcp.json. Registrations are not persisted by pi,
 * so re-registering on every extension load is the intended pattern.
 *
 * The URL can be overridden with the PIDR_KUBERNETES_MCP_URL environment
 * variable (the Nix wrapper could inject a cluster-specific value).
 * A mcp.json entry with the same name would take precedence over this
 * registration, which keeps an escape hatch for per-user overrides.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SERVER_NAME = "kubernetes";
const DEFAULT_URL = "https://kubernetes-mcp.k8s.pukabos.xyz/mcp";

export default function (pi: ExtensionAPI) {
	const url = process.env.PIDR_KUBERNETES_MCP_URL || DEFAULT_URL;
	try {
		pi.registerMcpServer(SERVER_NAME, {
			url,
			type: "http",
			description:
				"Homelab Kubernetes cluster (read-mostly): list and inspect pods, deployments, services and other resources.",
		});
	} catch (e) {
		console.warn(`[pidr-mcp-kubernetes] ${e instanceof Error ? e.message : e}`);
	}
}
