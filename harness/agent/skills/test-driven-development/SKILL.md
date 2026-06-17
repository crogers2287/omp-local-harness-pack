---
name: test-driven-development
description: Use when adding or changing testable behavior. Write the failing test first, then the minimum code to pass.
---

# Test-Driven Development

Use when the change has a clear, testable contract.

## Cycle

1. Red — write the smallest failing test for one behavior.
2. Verify the failure is the expected one.
3. Green — write the minimum code to make it pass.
4. Refactor — clean up while keeping tests green.
5. Repeat one behavior at a time.

## Rules

- One failing test at a time.
- Test behavior, not implementation trivia.
- Name the test for the behavior it proves.
- If you cannot write a meaningful failing test first, say so and do not fake TDD.
- For bug fixes, the regression test should fail before the fix and pass after it.

## When not to use

- Pure refactors with no behavior change.
- One-off exploratory scripts.
- Changes where visual/manual inspection is the real check.
