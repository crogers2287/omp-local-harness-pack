---
name: brainstorming
description: Use before open-ended feature, product, or architecture work. Clarify intent and tradeoffs before implementation.
---

# Brainstorming

Use when the request is vague, open-ended, or design-heavy.

## Goal

Turn a fuzzy idea into one recommended direction.

## Process

1. Restate the goal in one sentence.
2. Inspect the current repo/context first.
3. Ask 3-5 sharp questions, one at a time when possible:
   - user/caller
   - success criterion
   - constraints
   - out-of-scope
   - simplest useful version
4. Sketch 2-3 approaches with one-line tradeoffs.
5. Recommend one approach and explain why.
6. Stop. Do not implement until the user approves a direction.

## Rules

- Keep it short. For small work, a few sentences may be enough.
- Prefer concrete tradeoffs over brainstorming fluff.
- If the answer is already in the repo, read it instead of asking.
- Do not write code, docs, or plans yet.

## Anti-patterns

- Jumping into code on a fuzzy request.
- Asking a wall of questions at once.
- Presenting one "obvious" solution without alternatives.
