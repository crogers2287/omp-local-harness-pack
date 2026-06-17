---
name: verification-before-completion
description: Use before claiming work is done, fixed, or working. Run the relevant checks and show evidence.
---

# Verification Before Completion

Use immediately before any completion claim.

## Required evidence

Run and report whichever apply:

- tests
- typecheck or lint
- build
- original repro
- smoke check of the changed behavior

## Rules

- "Looks right" is not verification.
- A passing compile does not prove product behavior.
- If you could not run a check, say exactly what was not verified and why.
- Do not hide failures. Report them.
- Verification must match the claim being made.

## Output template

```text
Verified:
- tests: <command> — <result>
- repro: <command or flow> — <result>

Not verified:
- <thing> — <why>
```

## Anti-patterns

- "Should work now."
- "All tests pass" after running only one unrelated check.
- Declaring success before re-running the original failing case.
