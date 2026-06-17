# Local Model Notes

The harness is tuned for local OpenAI-compatible providers such as llama-swap or llama.cpp.

## Defaults worth keeping

- Small MCP allowlist.
- DRY sampling on local models to reduce repetition loops.
- `disableStrictTools: true` for llama.cpp/llama-swap compatibility.
- Early verification and loop-breaker gates.
- Explicit `/plan` for multi-phase work.

## Cold-start caution

Some local tool-calling models behave worse on first inference after load. Before long delegated work, run a small smoke prompt that requires one safe tool call or a simple response.

## Subagents

The bundled `pi-subagent` extension is adapted for OMP v16:

- raw Zod: `pi.zod.object(...)`
- no TUI dependency chain
- parent session snapshot is passed to the subprocess
- avoid setting subagent `cwd` unless necessary, because preserving context shape helps KV-cache reuse

## Binary updates

For reproducible OMP updates, prefer direct GitHub release downloads over installer scripts. Pin the version you tested in your own deployment notes.
