# Package Boundary

Included:

- reusable OMP agent config templates
- model-provider examples with placeholder local endpoints
- small MCP allowlist template
- `consensus-evolve` extension source
- `pi-subagent` extension source
- local agents and skills
- `code-reasoning` stdout wrapper
- sanitized `mcp-llamaswap` server

Excluded:

- OMP sessions, terminal sessions, logs, SQLite DBs, WAL/SHM files
- memory stores, blobs, screenshots, browser state
- personal paths, private hosts, private model inventory
- OAuth/API credentials and credential stores
- disabled/broken third-party plugin experiments

Notably excluded: `pi-mcp-adapter`. It is useful conceptually for lazy MCP proxying, but the tested package version failed to load in this OMP environment because its extension imports unresolved bare dependencies. Do not ship it by default until it loads cleanly in the target OMP version.
