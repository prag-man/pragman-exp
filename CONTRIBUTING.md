# Contributing

Pragman Exp is a small control plane with strict privacy and compatibility boundaries. Contributions should make real work faster or more reliable without adding ceremony to simple tasks.

## Set up

Use Node.js 22 or 24 and npm:

```sh
npm ci
npm test
npm run build
```

Keep changes focused. Do not commit generated package archives, local Pragman state, host histories, credentials, private paths, or real user/session content.

## Development loop

For behavior changes, work in a red → green → refactor loop:

1. Add one integration-style test that describes observable behavior and run it to verify the expected failure.
2. Implement the smallest complete vertical slice and rerun the focused test.
3. Repeat for the next behavior; refactor only while green.
4. Run the proportionate aggregate gate once the boundary is complete.

Tests should exercise public interfaces, deterministic outputs, privacy limits, failure behavior, and manual degradation—not private helpers.

## Skill changes

Each public skill lives in `skills/<name>/` and includes:

- a concise `SKILL.md` with only `name` and `description` frontmatter;
- `COMPATIBILITY.md` and `agents/openai.yaml`;
- only one level of directly relevant references or assets;
- at least three sanitized evaluation scenarios, including security and degradation cases required by its acceptance matrix.

Pragman builds on provider collections. Do not vendor, fork, silently rewrite, or misrepresent gstack, Compound Engineering, Superpowers, or another provider. Provider discovery metadata is not automatic trust or permission to invoke.

Every evaluation fixture must be synthetic or sanitized. Never paste a real transcript and then try to redact it in the pull request. Content-free event fixtures may contain stable synthetic identifiers, digests, timings, lifecycle states, and scores; they may not contain prompts, responses, company prose, or credentials.

## Before opening a pull request

```sh
npm test
npm run build
npm run validate:skills
npm run evals
npm pack --dry-run
node scripts/verify-package.mjs
git diff --check
```

Explain the user outcome, relevant tradeoffs, verification evidence, and any compatibility change. Security-sensitive fixes should use private vulnerability reporting instead of a public pull request until coordinated.

