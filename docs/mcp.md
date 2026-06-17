# MCP Setup

This harness keeps MCP intentionally small.

## Enabled by default

- `context7` — current library and framework docs.
- `sequential-thinking` — explicit decomposition when repeated attempts fail.
- `code-reasoning` — code-reasoning MCP wrapped by `mcp-wrappers/code-reasoning-silent.mjs` so log notifications do not corrupt stdout JSON-RPC.
- `llamaswap` — optional local-model control plane. Configure this only if you run a compatible server.

## Why most MCP servers are disabled

Each MCP server increases startup failure risk, tool descriptions, and context pressure. Local models are especially sensitive to oversized tool inventories. Start with the small allowlist and enable extra servers only when you can verify they connect and are useful.

## llama-swap MCP

The template expects a local checkout at:

```text
~/.local/share/omp-harness/mcp-llamaswap/index.js
```

Set in `~/.omp/agent/mcp.json`:

```json
"LLAMASWAP_URL": "http://localhost:9069",
"DEFAULT_MODEL": "local-primary"
```

Do not publish private hostnames or model inventory from your own LAN.
