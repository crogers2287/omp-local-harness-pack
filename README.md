# OMP Local Harness Pack

A sanitized, public package of an Oh My Pi / OMP harness tuned for local models, self-healing workflows, plan-mode discipline, and a small MCP surface.

This repository intentionally contains only reusable harness artifacts:

- OMP agent config templates
- local-model model-provider examples
- a small MCP allowlist template
- `consensus-evolve` self-healing extension
- KV-cache-preserving `pi-subagent` extension
- focused agents: `task-planner`, `focus-coder`
- focused skills: brainstorming, systematic debugging, TDD, verification before completion
- MCP wrappers and setup notes

It intentionally does not contain runtime state: sessions, logs, SQLite DBs, memories, blobs, auth files, API keys, OAuth tokens, cookies, or private hostnames.

## Install

Review the files first, then run:

```bash
./scripts/install.sh
```

The installer backs up existing files before copying into `~/.omp/agent`. It copies `models.yml.example` to `models.yml` only if you do not already have one.

After install, edit:

- `~/.omp/agent/models.yml` — set your local model endpoint and model IDs.
- `~/.omp/agent/mcp.json` — set your `LLAMASWAP_URL`, `DEFAULT_MODEL`, and optional `mcp-llamaswap` path.
- `~/.omp/agent/consensus-evolve/config.json` — set panel models that actually exist in your OMP config.

## MCP surface

Default MCP allowlist:

- Context7
- Sequential Thinking
- Code Reasoning, through a stdout-sanitizing wrapper
- llama-swap MCP, optional and local

Everything else is disabled by default in the template to reduce startup failures and context bloat.

## Local-model notes

- Keep the harness boring: fewer MCP servers, fewer always-on skills, explicit verification gates.
- Warm local models with a smoke prompt before long delegated tasks; some local tool-calling models can fail on first cold inference.
- For OMP v16 extensions, use raw Zod schemas (`pi.zod.object(...)`), not wrapped `pi.zod.z.object(...)`.
- Avoid passing unnecessary subagent `cwd`; preserving the parent context shape helps KV-cache reuse.

## Plan mode

`consensus-evolve.ts` includes a `/plan` command that uses the `task-planner` agent format:

```text
<<<PLAN>>>
[
  {"name":"...","verify":"...","brief":"..."}
]
<<<END PLAN>>>
```

Plans are persisted in the local `~/.omp/agent/consensus-evolve` runtime directory. Runtime plan/log/evolution files are not part of this repo.

## Security

Before publishing your own fork, run the sanitization checks in `docs/sanitization.md` and verify no private topology, absolute home paths, secrets, runtime DBs, session logs, or memory artifacts are included.
