---
name: systematic-debugging
description: Use when behavior is broken, failing, or surprising. Follow a hypothesis-driven loop instead of patching on guesses.
---

# Systematic Debugging

Use for bugs, regressions, failing tests, build failures, and unexpected behavior.

## Loop

1. Reproduce the issue reliably.
2. Observe the real error, stack trace, inputs, and surrounding state.
3. State one concrete hypothesis.
4. Test that hypothesis with evidence.
5. If the hypothesis dies, form a new one.
6. Fix the root cause, not the symptom.
7. Add or update a regression test when applicable.

## Rules

- No fix before investigation.
- One hypothesis at a time.
- Prefer smaller repros and narrower checks.
- In multi-step systems, locate the failing boundary first.
- Re-run the original repro after the fix.

## Anti-patterns

- "Let me try a few things."
- Adding guards, retries, or try/catch without knowing why.
- Fixing the downstream crash when the bad input is upstream.
- Claiming success without reproducing the original failure and showing it is gone.
