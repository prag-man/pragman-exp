# Pragman Exp v1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship eight portable Pragman skills, a deterministic local CLI, layered workspace configuration, adaptive capability routing, safe session analysis, and a repository that passes live Codex/Claude behavior plus remote `skills`/skills.sh installation tests.

**Architecture:** Keep reasoning and interviews in concise portable skills while a Node.js CLI owns deterministic parsing, validation, redaction, routing, atomic changes, rollback, and reports. Publish one npm package whose binary, schemas, providers, and host adapters support every skill, while retaining explicit manual degradation without the CLI. Follow the approved vertical-unit order; each skill receives RED → GREEN → validation before the next unit starts.

**Tech Stack:** Node.js 22/24, TypeScript, npm, `node:test` via `tsx`, YAML, AJV JSON Schema, GitHub Actions, Agent Skills `SKILL.md`, `agents/openai.yaml`, and Vercel `skills` CLI 1.5.x or compatible.

---

## File map

- `package.json`, `tsconfig.json`: package metadata, `pragman` binary, build/test/eval/release scripts.
- `packages/config/schemas/`: normative JSON Schemas from spec Sections 23–30.
- `packages/config/src/`: paths, validation, layered merge, atomic writes, migrations, previews, apply, rollback.
- `packages/provider-registry/src/`: capability/provider records, discovery, health, trust, compatibility.
- `packages/router/src/`: structured rules, lane derivation, scores, deterministic set cover/order, approvals, explanations.
- `packages/redaction/src/`: deterministic secret/sensitive-value redaction.
- `packages/session-adapters/src/`: bounded Codex/Claude JSONL and Cursor Markdown ingestion.
- `packages/reports/src/`: JSON, Markdown, and escaped self-contained HTML reports.
- `packages/cli/src/`: stable envelope, lock, arguments, command handlers, executable entrypoint.
- `providers/`: reviewed Pragman, gstack, Compound Engineering, and Superpowers definitions.
- `host-adapters/{codex,claude-code,cursor}/`: concrete discovery, invocation/handoff, cancellation, collection, and session-source adapters plus compatibility metadata.
- `skills/pragman-*/`: independently installable `SKILL.md`, one-level references/assets, `agents/openai.yaml`, `COMPATIBILITY.md`, and `evals/`.
- `evals/fixtures/`, `evals/golden/`: sanitized shared fixtures and deterministic route/security oracles.
- `scripts/`: static validation, eval runner, package verification, live host smoke tests, remote install tests.
- `.github/workflows/`: CI and trusted release automation.

## Task 1: Foundation, schemas, CLI shell, and security baseline

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `packages/config/schemas/{personal-config,profile,workspace,project,routing,provider,capability,task-contract,route-evidence,session-event,learning,change-record,envelope}.schema.json`
- Create: `packages/cli/src/{index,args,envelope}.ts`
- Create: `packages/redaction/src/index.ts`
- Create: `scripts/run-evals.mjs`
- Create: `tests/contracts/*.test.ts`, `tests/redaction/*.test.ts`

- [ ] Write failing tests requiring Node `>=22 <25`, `pragman` bin, exact normative schema path/files, AJV compilation, JSON envelope/exit classes, and representative secret redaction/injection inertness.
- [ ] Run `npm test -- tests/contracts tests/redaction`; verify RED from missing runtime files.
- [ ] Add minimal package tooling, schemas, CLI `--version --json`, envelope helpers, redactor, and a skill-local JSON eval runner that validates scenario inputs/expected invariants and records baseline/forward-test evidence.
- [ ] Run `npm install`, focused tests, and `npm run build`; expect PASS/exit 0.
- [ ] Commit: `chore: establish pragman foundation`.

## Task 2: `pragman-workspace` vertical unit

Before this task, complete the separately reviewed foundational event plan at `docs/superpowers/plans/2026-08-10-pragman-skill-events.md`. All subsequent skills and provider adapters instrument through that package; event failures remain non-blocking.

**Files:**
- Create: `packages/config/src/{types,paths,loader,merge,atomic-write,changes,index}.ts`
- Create: `packages/cli/src/commands/workspace.ts`
- Create: `tests/config/*.test.ts`, `tests/cli/workspace.test.ts`
- Create: `skills/pragman-workspace/{SKILL.md,COMPATIBILITY.md,agents/openai.yaml,references/*.md,evals/*.json}`

- [ ] Write failing code tests for personal-only/workspace-only/linked-project context, ordered secondary sources, scalar conflicts, safety accumulation, invalid/newer schemas, atomic writes, stale preview, apply, and rollback.
- [ ] Run focused tests; verify RED.
- [ ] Implement validated loading, exact precedence/provenance, conflicts, digests, lock, constrained JSON Patch, snapshots, atomic apply, rollback, and workspace add/edit/list/link/unlink/validate commands.
- [ ] Run three skill baseline scenarios without the skill and store redacted observations in its `evals/`: multiple workspaces, primary linking, and canonical-context indexing/privacy.
- [ ] Initialize via `init_skill.py`; write the minimum skill/manual degradation/reference guidance addressing observed failures, plus compatibility/UI metadata.
- [ ] Forward-test the same scenarios with the skill; revise material failures only.
- [ ] Run focused code tests, `quick_validate.py`, and skill evals; expect PASS.
- [ ] Commit: `feat: add pragman workspace`.

## Task 3: `pragman-init` vertical unit

**Files:**
- Create: `packages/cli/src/commands/{init,scan,doctor}.ts`
- Create: `packages/provider-registry/src/discovery.ts` (discovery records only; no routing yet)
- Create: `tests/cli/{init,scan,doctor}.test.ts`
- Create: `skills/pragman-init/{SKILL.md,COMPATIBILITY.md,agents/openai.yaml,references/*.md,evals/*.json}`

- [ ] Write failing tests for clean/populated/broken/shadowed environments, known-host metadata-only scan, no secret-store reads, preview-before-write, doctor, and sample manual route.
- [ ] Run tests; verify RED.
- [ ] Implement bounded discovery and init/scan/doctor commands without invoking discovered content.
- [ ] Baseline-test clean, populated, and shadowed environments; record over-questioning, secret-read, and unreviewed-write failures.
- [ ] Initialize and write adaptive discovery/interview/review/apply/health/sample-route instructions and CLI-unavailable behavior.
- [ ] Forward-test all three scenarios, validate, run focused tests, and commit: `feat: add pragman init`.

## Task 4: Provider registry, concrete host adapters, router, and `pragman-router`

**Files:**
- Create: `packages/provider-registry/src/{types,registry,index}.ts`
- Create: `packages/router/src/{types,rules,lanes,scoring,sequences,approvals,route,index}.ts`
- Create: `providers/{capabilities,pragman,gstack,compound-engineering,superpowers}.yaml`
- Create: `host-adapters/{types.ts,compatibility.json,codex/index.ts,claude-code/index.ts,cursor/index.ts}`
- Create: `packages/cli/src/commands/{providers,route}.ts`
- Create: `evals/golden/router.json`, `tests/providers/*.test.ts`, `tests/router/*.test.ts`, `tests/host-adapters/*.test.ts`
- Create: `skills/pragman-router/{SKILL.md,COMPATIBILITY.md,agents/openai.yaml,references/*.md,evals/*.json}`

- [ ] Write failing provider/host tests for schema, cycles, trust, digest drift, shadowing, health, version compatibility, bounded context, invoke/prompt/manual handoff, cancellation, collection, session sources, and no false success.
- [ ] Write at least 32 golden route cases (8 per lane) plus ties, recursion, missing provider, egress, fallback, fan-out dependency, secondary conflict, and route split; verify RED.
- [ ] Implement provider registry, concrete host adapter interface, structured predicates, exact lanes, eligibility, scores, learning confidence, deterministic set cover/order, approval matrix, recursion, and explanation.
- [ ] Baseline-test obvious fast, ambiguous deep, and operational work without the skill; record needless interviews/hidden substitution.
- [ ] Initialize/write the adaptive router skill; forward-test all lanes, disclosure, fallback, recursion, and manual degradation.
- [ ] Run all focused tests/validators/evals and commit: `feat: add pragman adaptive router`.

## Task 5: `pragman-research` vertical unit

**Files:** `skills/pragman-research/{SKILL.md,COMPATIBILITY.md,agents/openai.yaml,references/*.md,evals/*.json}`

- [ ] Baseline-test all five required methods: quick, technical source-first, fan-out, decision, and internal research; capture unnecessary breadth, weak sources, and fact/inference mixing.
- [ ] Initialize/write decision-first method selection, freshness/source quality, disagreements, egress, and actionable synthesis guidance.
- [ ] Forward-test all five methods and counter-examples; validate and commit: `feat: add pragman research`.

## Task 6: `pragman-shape` vertical unit

**Files:** `skills/pragman-shape/{SKILL.md,COMPATIBILITY.md,agents/openai.yaml,references/*.md,evals/*.json}`

- [ ] Baseline-test a vague idea, oversized build, and low-evidence bet; capture premature solutioning and absent kill criteria.
- [ ] Initialize/write problem/evidence/outcome/smallest-bet/non-goals/success/kill/dependency/route contract plus provider handoff.
- [ ] Forward-test all scenarios, validate, and commit: `feat: add pragman shape`.

## Task 7: `pragman-prototype` vertical unit

**Files:** `packages/reports/src/{html,index}.ts`, `tests/reports/html.test.ts`, `skills/pragman-prototype/{SKILL.md,COMPATIBILITY.md,agents/openai.yaml,references/*.md,assets/prototype.html,evals/*.json}`

- [ ] Write failing HTML tests for escaping, no default network, accessibility landmarks, and self-contained output; verify RED.
- [ ] Implement the minimal HTML packager.
- [ ] Baseline-test one-flow exploration, useful variants, and confidential design context; capture production overinvestment and unsafe output.
- [ ] Initialize/write design-provider routing, preview, feedback, iteration, and promotion guidance with reusable accessible starter asset.
- [ ] Forward-test clickability/security/prototype status, run tests/validation, and commit: `feat: add pragman prototype`.

## Task 8: `pragman-analyze` vertical unit

**Files:** `packages/reports/src/{json,markdown}.ts`, `tests/reports/analysis.test.ts`, `skills/pragman-analyze/{SKILL.md,COMPATIBILITY.md,agents/openai.yaml,references/*.md,evals/*.json}`

- [ ] Write failing renderer tests for evidence/confidence and exact action groups; verify RED, then implement minimal renderers.
- [ ] Baseline-test successful, drifted, and blocked work; capture generic retrospective and unsupported mutation.
- [ ] Initialize/write all eleven analysis dimensions plus `Keep/Change/Stop/Automate/Learn/Test next`, evidence/confidence, and no automatic mutation.
- [ ] Forward-test all scenarios, run tests/validation, and commit: `feat: add pragman analyze`.

## Task 9: Session pipeline and `pragman-unfck` vertical unit

**Files:**
- Create: `packages/session-adapters/src/{types,limits,jsonl,codex,claude,cursor-markdown,scan,index}.ts`
- Create: `packages/cli/src/commands/{sessions,tune,changes,history}.ts`
- Create: `evals/fixtures/sessions/*`, `tests/sessions/*.test.ts`, `tests/cli/unfck.test.ts`
- Create: `skills/pragman-unfck/{SKILL.md,COMPATIBILITY.md,agents/openai.yaml,references/*.md,evals/*.json}`

- [ ] Write failing tests for stable IDs, selection, root/symlink containment, limits, unknown/corrupt formats, 10% threshold, prompt injection, secret corpus, Cursor Markdown, retention/purge, preview/apply/rollback; verify RED.
- [ ] Implement bounded local parsing, normalized events, quarantine/partial success, redacted evidence, metrics, sessions/tune/change/history commands.
- [ ] Consume only user-approved `eval-candidate` records from the foundational skill-events package; preview the sanitized corpus addition, rerun the target skill's evaluations, and require approval again before applying it. Pending candidates never write a corpus.
- [ ] Baseline-test mixed-host history, missing intent, injected transcript, corrupt source, and proposed tuning; capture log-only diagnosis and unapproved edits.
- [ ] Initialize/write privacy selection, ingestion, focused questioning, symptom/root-cause separation, exact diff, eval, approval, apply, rollback, and separate sanitized upstream guidance.
- [ ] Forward-test every baseline/security scenario, run tests/validation, and commit: `feat: add pragman unfck`.

## Task 10: Common skill suite, remaining CLI, and local end-to-end

**Files:**
- Create: `packages/cli/src/commands/eval.ts`
- Create: `scripts/validate-skills.mjs`
- Create: `tests/cli/all-commands.test.ts`, `tests/e2e/pragman-flow.test.ts`
- Modify: `package.json`

- [ ] Write failing checks for exactly eight unique skills; two-field frontmatter; under-500-line bodies; valid one-level references; matching UI metadata; `COMPATIBILITY.md`; manual degradation; local `evals/` with at least three scenarios and every stricter acceptance-matrix scenario.
- [ ] Implement aggregate validators and the remaining `eval` command on top of the Task 1 eval runner; ensure every Section 8 command has JSON/human/non-interactive behavior and stable exits.
- [ ] Test init → workspace → scan → route → provider handoff → session analysis → report → preview/apply/rollback in temporary roots.
- [ ] Run `npm test`, `npm run build`, `npm run validate:skills`, `npm run eval`; commit: `test: add pragman end-to-end gates`.

## Task 11: Public repository, live hosts, npm, GitHub release, and skills.sh

**Files:**
- Create: `README.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`
- Create: `.github/workflows/{ci,release}.yml`
- Create: `scripts/{verify-package,test-live-hosts,test-remote-install}.mjs`
- Create: `docs/operations/release-checklist.md`

- [ ] Add tests for npm pack contents, no private paths/secrets, documented commands, macOS/Ubuntu × Node 22/24 CI, and a trusted-tag provenance release using npm CLI `>=11.5.1`.
- [ ] Run full local gate and `npm pack --dry-run`; inspect contents and commit: `chore: prepare pragman public release`.
- [ ] Run live behavioral smoke tests on latest supported Codex and Claude Code using sanitized tasks; run portable skill + Cursor Markdown adapter acceptance; require exact recorded invariants.
- [ ] Push the verified branch, wait for GitHub CI, and integrate through `finishing-a-development-branch`.
- [ ] Bootstrap the new npm scope before trusted publishing: set package version `0.1.0-beta.0`, require `npx npm@11.5.1 whoami`, and publish the verified package once with `npx npm@11.5.1 publish --access public --tag beta`. If npm is unauthenticated, stop at this mandatory credential gate, ask the user to authenticate, then resume.
- [ ] Install the beta package in a temporary prefix and run `pragman doctor --json`; do not call v1 complete from the beta.
- [ ] Register the repository/tag release workflow as the npm trusted publisher for `@prag-man/pragman-exp`, bump the same verified source to stable `0.1.0`, rerun the full gate, and commit the version-only release change.
- [ ] Create and push signed/annotated tag `v0.1.0`. The tag-triggered GitHub workflow must use npm CLI `>=11.5.1`, OIDC `id-token: write`, and publish stable `0.1.0` with provenance before creating the GitHub release/checksums.
- [ ] Verify npm stable metadata, provenance, GitHub release assets, and that both resolve to the tagged commit.
- [ ] Run remote `npx skills add prag-man/pragman-exp --list`; assert all eight names.
- [ ] Install one skill and all skills into isolated Codex, Claude Code, and Cursor project roots; verify exact files. Run `skills use` for `pragman-router` where supported.
- [ ] Run a clean-clone full gate from `origin/main`, check skills.sh repository/API after documented cache intervals, and record evidence.
- [ ] Commit/publish only evidence that contains no private paths, tokens, or session content.

## Final verification gate

- [ ] Map every spec v1 acceptance criterion to a fresh passing test, public artifact, live-host result, or completed publication—not a waived blocker.
- [ ] Run fresh `npm ci`, `npm test`, `npm run build`, `npm run validate:skills`, `npm run eval`, and `npm pack --dry-run`.
- [ ] Re-run live Codex/Claude smoke tests and remote skills list/install/use tests from clean temporary directories.
- [ ] Inspect `git diff --check`, clean status, pushed commit, GitHub CI, npm package, GitHub release, skills.sh result, and public repository for private data.
