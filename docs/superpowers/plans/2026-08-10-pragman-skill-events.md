# Pragman Skill Events Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe local skill lifecycle events, delayed scores, sealed rollups, comparable skill-on/off evaluation, and non-blocking instrumentation to the Pragman CLI foundation.

**Architecture:** Keep public contracts as strict JSON Schemas and TypeScript types, store immutable records in date-partitioned JSONL under the selected private state root, and calculate summaries through pure metric functions. Separate best-effort observation from durable event commands. Compact expiring raw cohorts into verified sealed daily rollups and derive weekly rollups from daily records.

**Tech Stack:** Node.js 22/24, TypeScript, `node:test`, AJV 2020-12 JSON Schema, JSONL, SHA-256 canonical digests, and the existing Pragman JSON envelope/exit classes.

---

## File map

- `packages/config/schemas/skill-event.schema.json`: revise the lifecycle contract for nullable production/eval fields and comparability digests.
- `packages/config/schemas/skill-score.schema.json`: immutable delayed/corrected score contract.
- `packages/config/schemas/skill-metric.schema.json`: published value-domain, direction, pass-rule, and verifier contract.
- `packages/config/schemas/skill-rollup.schema.json`: derived/sealed aggregate contract without invocation identifiers.
- `packages/config/schemas/eval-candidate.schema.json`: content-free approval bridge from observed failures to later unfck corpus changes.
- `packages/config/schemas/eval-candidate-approval.schema.json`: immutable user decision bound to candidate/artifact digests.
- `packages/events/src/types.ts`: schema-aligned runtime interfaces and result unions.
- `packages/events/src/canonical.ts`: stable serialization, SHA-256 digests, and UUIDv7-compatible IDs.
- `packages/events/src/validation.ts`: AJV loaders plus cross-record metric/score validation.
- `packages/events/src/paths.ts`: contained date-partitioned state paths.
- `packages/events/src/store.ts`: durable and deadline-bounded append/read/quarantine primitives.
- `packages/events/src/lifecycle.ts`: invocation lifecycle, idempotency, collision, and score-chain rules.
- `packages/events/src/metrics.ts`: pure routing/outcome/reliability/normalized-utility calculations with denominators.
- `packages/events/src/ablation.ts`: strict cohort comparability and paired deltas.
- `packages/events/src/rollups.ts`: daily/weekly rollups, sealing, verification, and rebuild.
- `packages/events/src/recommendations.ts`: advisory regression/drift/improve/retire/retain/reactivate candidates.
- `packages/events/src/eval-candidates.ts`: content-free real-failure candidate records; no corpus writes.
- `packages/events/src/settings.ts`: validated config loading and `measurement.local_events` default resolution before the full workspace loader exists.
- `packages/events/src/retention.ts`: compact-before-delete and explicit purge planning/apply.
- `packages/events/src/export.ts`: aggregate-first de-identified export.
- `packages/events/src/index.ts`: public package surface.
- `packages/cli/src/commands/events.ts`: event record/score/list/summary/rebuild/export/purge handlers.
- `packages/cli/src/commands/eval.ts`: eval comparison handler.
- `packages/cli/src/args.ts`, `packages/cli/src/index.ts`: command parsing and stable envelopes.
- `evals/metrics/*.json`: initial public metric definitions used by fixtures.
- `scripts/run-evals.mjs`: emit comparable content-free evaluation evidence.
- `tests/events/*.test.ts`, `tests/cli/events.test.ts`, `tests/e2e/skill-events.test.ts`: contract, storage, metric, command, and end-to-end gates.

## Task 1: Schemas, metric registry, and validation

**Files:**
- Modify: `packages/config/schemas/personal-config.schema.json`
- Modify: `packages/config/schemas/skill-event.schema.json`
- Create: `packages/config/schemas/skill-score.schema.json`
- Create: `packages/config/schemas/skill-metric.schema.json`
- Create: `packages/config/schemas/skill-rollup.schema.json`
- Create: `packages/config/schemas/eval-candidate.schema.json`
- Create: `packages/config/schemas/eval-candidate-approval.schema.json`
- Create: `packages/events/src/types.ts`
- Create: `packages/events/src/canonical.ts`
- Create: `packages/events/src/validation.ts`
- Create: `packages/events/src/index.ts`
- Create: `evals/metrics/task-success.json`
- Test: `tests/events/contracts.test.ts`

- [ ] **Step 1: Write failing schema and cross-record tests**

Cover all six event-system schemas, `measurement.local_events=true` default independent from `telemetry.enabled=false`, no arbitrary event/score/rollup/candidate/approval text, nullable production trigger expectation, full comparison digests/versions, known-secret rejection, exactly one metric domain, bounded category IDs/ranks, valid pass-rule/operator pairs, complete lifecycle-policy thresholds, score domain/source eligibility, canonical digest stability, and score metric-definition digest matching.

Representative test shape:

```ts
const result = validators.score(score, metric);
assert.deepEqual(result, { ok: false, code: "METRIC_DIGEST_MISMATCH" });
assert.equal(eventValidator({ ...validEvent, prompt: "private" }), false);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/events/contracts.test.ts`

Expected: FAIL because score/metric/rollup schemas and event validation package do not exist.

- [ ] **Step 3: Implement minimum schema-aligned types and validators**

Use AJV 2020-12 with formats. Export:

```ts
export interface EventValidators {
  event(value: unknown): ValidationResult<SkillEvent>;
  metric(value: unknown): ValidationResult<SkillMetric>;
  score(value: unknown, metric: SkillMetric): ValidationResult<SkillScore>;
  rollup(value: unknown): ValidationResult<SkillRollup>;
}

export function canonicalJson(value: unknown): string;
export function sha256Digest(value: unknown): string;
```

Reject unknown metric digests and values outside the metric's domain after schema validation. Keep descriptive metric text in the public registry only; persisted events, scores, and rollups accept bounded IDs/numbers/hashes only.

- [ ] **Step 4: Run focused and foundation tests**

Run: `npm test -- tests/events/contracts.test.ts tests/contracts/schemas.test.ts tests/redaction`

Expected: PASS.

- [ ] **Step 5: Build and commit**

Run: `npm run build && git diff --check`

Commit: `feat: define skill event contracts`

## Task 2: Append-only store and lifecycle integrity

**Files:**
- Create: `packages/events/src/paths.ts`
- Create: `packages/events/src/store.ts`
- Create: `packages/events/src/lifecycle.ts`
- Modify: `packages/events/src/index.ts`
- Test: `tests/events/store.test.ts`
- Test: `tests/events/lifecycle.test.ts`

- [ ] **Step 1: Write failing store tests**

Cover contained date paths, root/symlink escape denial, one-record-per-line canonical JSONL, durable sync, exact duplicate idempotency, divergent duplicate quarantine, concurrent writers, truncated-tail quarantine with earlier lines preserved, and no mutation of prior lines.

- [ ] **Step 2: Write failing lifecycle and score-chain tests**

Cover invoked → completed/cancelled → verified transitions, incomplete lifecycle reporting, no synthetic success, unknown invocation score rejection, linear correction, missing predecessor, identity mismatch, cycle, fork, and retention anchored to invocation time. Also cover a decision for an unknown candidate, candidate/artifact digest mismatch, exact duplicate decision idempotency, divergent ID collision, and a second/conflicting decision.

- [ ] **Step 3: Run tests to verify RED**

Run: `npm test -- tests/events/store.test.ts tests/events/lifecycle.test.ts`

Expected: FAIL from missing store/lifecycle modules.

- [ ] **Step 4: Implement durable append and safe readers**

Expose:

```ts
export async function appendDurable(
  root: string,
  recordType: "skill-events" | "scores" | "eval-candidates" | "candidate-approvals",
  record: SkillEvent | SkillScore | EvalCandidate | EvalCandidateApproval,
): Promise<AppendResult>;

export async function readPartition<T>(...): Promise<ReadPartitionResult<T>>;
```

Resolve the configured root before path construction, reject root `/`, never follow a partition symlink outside it, take the state mutation lock, open with append semantics, write one canonical line, sync, and release in `finally`. Quarantine only invalid identities or the malformed tail; never reinterpret content as instructions.

- [ ] **Step 5: Implement lifecycle and score-chain index validation**

Build indexes from validated retained records. Return structured reason codes rather than prose. Enforce one terminal execution event, delayed verification, exact duplicate digest idempotency, a single score successor with the exact identity fields from the design, and one digest-bound decision per known evaluation candidate.

- [ ] **Step 6: Run focused/full tests and commit**

Run: `npm test -- tests/events && npm run build && git diff --check`

Expected: PASS.

Commit: `feat: store immutable skill event history`

## Task 3: Metrics, ablation, rollups, and bounded instrumentation

**Files:**
- Create: `packages/events/src/metrics.ts`
- Create: `packages/events/src/ablation.ts`
- Create: `packages/events/src/rollups.ts`
- Create: `packages/events/src/recommendations.ts`
- Modify: `packages/events/src/store.ts`
- Modify: `packages/events/src/index.ts`
- Test: `tests/events/metrics.test.ts`
- Test: `tests/events/ablation.test.ts`
- Test: `tests/events/rollups.test.ts`
- Test: `tests/events/recommendations.test.ts`
- Test: `tests/events/best-effort.test.ts`

- [ ] **Step 1: Write failing metric tests**

Cover precision/recall/no-op formulas with explicit denominators, exclusion of unknown production expectations, completion/verified-success eligibility, reliability from metric pass rules, raw score means, direction-normalized utility for maximize/minimize/point-target/range-target/boolean/category metrics, and duration/retry/rework/tool/verification distributions.

- [ ] **Step 2: Write failing ablation tests**

Cover identical paired cohorts, missing arm, changed corpus/trial policy, unpaired case/trial IDs, changed host/model/harness versions, changed provider/skill/metric/grader/rubric digests, fewer-than-20 raw-pair output, raw metric deltas, normalized utility lift, and comparable outcome/verified-success/efficiency deltas.

- [ ] **Step 3: Write failing rollup and deadline tests**

Cover bounded grouping dimensions, no IDs/source aliases, source count/digest, latest valid correction, daily → weekly aggregation, sealing, sealed-history preservation during rebuild, and injected stalled lock/append returning best-effort `recorded=false` within the fake-clock 30 ms oracle. Add advisory regression/drift/improve/retire-capability/retain-preference/reactivate cases driven only by comparable rollups and the metric's exact lifecycle policy; test threshold boundaries, minimum trials/environments, previously retired state, efficiency materiality, and insufficient/incomparable evidence.

- [ ] **Step 4: Run tests to verify RED**

Run: `npm test -- tests/events/metrics.test.ts tests/events/ablation.test.ts tests/events/rollups.test.ts tests/events/recommendations.test.ts tests/events/best-effort.test.ts`

Expected: FAIL from missing calculation modules/API.

- [ ] **Step 5: Implement pure calculations and strict comparison**

Use result types that always expose numerator/denominator or `INCOMPARABLE` reasons. Normalize metric values to utility exactly as specified before computing lifecycle lift. Do not infer metric direction or pass/fail from names. Sort paired trials and all emitted groups deterministically.

Implement lifecycle recommendations from normalized utility, pass rate, and efficiency deltas as immutable advisory records containing cohort/metric digests, evidence counts, exact policy thresholds, reason codes, and `approval_required=true`. They must not expose an apply function. `pragman-analyze` and `pragman-unfck` consume these records in later vertical units.

- [ ] **Step 6: Implement rollups and best-effort append**

Expose:

```ts
export async function appendBestEffort(
  deps: BestEffortDependencies,
  record: SkillEvent,
  policy?: { lockBudgetMs: 5; totalBudgetMs: 20 },
): Promise<{ recorded: boolean; reason: BestEffortReason | null }>;
```

Race the caller-facing result against the total deadline; let the append worker retain/release an acquired lock when it settles. Never sync or retry on this path.

- [ ] **Step 7: Run focused/full tests and commit**

Run: `npm test -- tests/events && npm run build && git diff --check`

Expected: PASS.

Commit: `feat: measure skill outcome lift`

## Task 4: Retention, export, and CLI commands

**Files:**
- Create: `packages/events/src/retention.ts`
- Create: `packages/events/src/export.ts`
- Create: `packages/events/src/settings.ts`
- Create: `packages/events/src/eval-candidates.ts`
- Create: `packages/cli/src/commands/events.ts`
- Create: `packages/cli/src/commands/eval.ts`
- Modify: `packages/events/src/index.ts`
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `tests/events/retention.test.ts`
- Test: `tests/events/export.test.ts`
- Test: `tests/events/eval-candidates.test.ts`
- Test: `tests/cli/events.test.ts`

- [ ] **Step 1: Write failing retention/export tests**

Cover 180-day invocation-cohort expiry, complete score-chain handling, 180-day candidate-plus-decision expiry, 30-day quarantine expiry, 2-year daily-rollup expiry, indefinite weekly-rollup retention, seal/verify/recompute-weekly before raw delete, retention debt on failure, preservation of older sealed rollups inside their retention period, explicit purge of selected classes/ranges, aggregate-first export, second choice for raw export, export-local cohort IDs, omission of session/route/invocation/source aliases, and exclusion of all candidate/artifact/approval data from exports.

- [ ] **Step 2: Write failing CLI tests**

Cover `events record|score|list|summary|rebuild|export|purge`, `events candidates list|decide`, and `eval run|compare`, stdin/file JSON input with no sensitive command arguments, human/JSON envelopes, invalid/privacy/needs-approval/temporary exit classes, non-interactive behavior, preview digest, stale apply denial, and event failure not changing an otherwise successful workflow result. Test absent config/default true, explicit false, malformed/newer config fail-closed, a temporary selected config path, and that disabling makes best-effort observation return `disabled` without affecting skill execution. Durable explicit `events record` returns a disclosed disabled result unless the user supplies an explicit one-command override.

Add candidate constructor/CLI tests before CLI integration: content-free pending creation, explicit user decision record creation, schema rejection of content fields, list/decide envelopes, and no corpus mutation API. Task 2 already owns and tests persistence idempotency, collision, digest binding, and one-decision lifecycle integrity.

- [ ] **Step 3: Run tests to verify RED**

Run: `npm test -- tests/events/retention.test.ts tests/events/export.test.ts tests/events/eval-candidates.test.ts tests/cli/events.test.ts`

Expected: FAIL because retention/export/command handlers do not exist.

- [ ] **Step 4: Implement compact-before-delete and export**

Produce immutable purge/export plans with canonical digest and expiry. Apply requires the current state digest and mutation lock. Automatic retention aborts deletion if sealing or weekly recomputation fails. Explicit purge reports that removed history is no longer rebuildable.

- [ ] **Step 5: Implement command grammar and handlers**

Implement `packages/events/src/settings.ts` as the minimal pre-workspace loader: read the selected personal config path (default `~/.pragman/config.yaml`), parse YAML/JSON, validate `personal-config.schema.json`, and explicitly resolve absent `measurement` to `{ local_events: true }`. Export a pure resolver so the later `packages/config/src/loader.ts` composes it instead of duplicating the rule.

Extend argument parsing without breaking `--version`. Route commands through focused handlers returning the stable envelope. `eval run` executes the local versioned evaluation runner and `eval compare` consumes its content-free paired evidence. `events record|score` durable mode is the requested primary operation; adapter instrumentation uses the package API, not a child CLI invocation. Read `measurement.local_events` through the minimal validated loader and keep it independent of remote telemetry.

Implement `createEvalCandidate` and `createEvalCandidateDecision` as pure validated record constructors. Persistence goes only through `appendDurable`; candidate lifecycle validation rejects missing/changed candidates and second decisions. Neither constructors nor CLI handlers expose corpus mutation.

- [ ] **Step 6: Run focused/full tests and commit**

Run: `npm test -- tests/events tests/cli && npm run build && git diff --check`

Expected: PASS.

Commit: `feat: add skill event control commands`

## Task 5: Evaluation runner integration and end-to-end proof

**Files:**
- Modify: `scripts/run-evals.mjs`
- Create: `evals/fixtures/skill-events/{baseline,forward}.json`
- Create: `tests/e2e/skill-events.test.ts`
- Modify: `tests/contracts/evals.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing integration test**

Exercise route-observed eligibility → invoke → complete → verify → delayed score → daily/weekly rollup → skill-on/off comparison → improve recommendation. Require content-free stored evidence, full environment/digest comparability, and no recommendation mutation.

- [ ] **Step 2: Add failing eval-runner compatibility tests**

Require 2–6 trials, explicit skill-on/off arms for capability scenarios, corpus/trial-policy/skill/environment/grader/metric/rubric digests, raw paired output under 20 pairs, and `INCOMPARABLE` on mismatch. Preserve the existing baseline/forward invariant runner behavior.

Add integration assertions that an approved candidate remains only an input to the later `pragman-unfck` change-preview flow; neither pending nor approved records can write the skill corpus directly.

- [ ] **Step 3: Run tests to verify RED**

Run: `npm test -- tests/contracts/evals.test.ts tests/e2e/skill-events.test.ts`

Expected: FAIL because the runner emits only legacy baseline/forward evidence.

- [ ] **Step 4: Extend the runner and add sanitized fixtures**

Add a versioned evaluation mode without persisting prompt/output values. Evidence stores only IDs, digests, pass/fail, bounded counters, and paired metric values. Do not introduce network calls or an LLM judge in the fixture suite.

Extend the later session/unfck plan to consume only approved candidate/decision pairs through its existing preview/eval/apply gate.

- [ ] **Step 5: Run the complete fresh gate**

Run:

```bash
npm test
npm run build
npm run evals
npm pack --dry-run
git diff --check
```

Expected: all commands exit 0 and packed files contain the six event-system schemas plus compiled event/CLI modules.

- [ ] **Step 6: Commit**

Commit: `test: prove skill event evaluation loop`

## Completion gate

- [ ] Map every acceptance criterion in `docs/superpowers/specs/2026-08-10-pragman-skill-events-design.md` to a fresh passing test.
- [ ] Run independent spec-compliance review, then independent code-quality review, fixing and re-reviewing all blocking findings.
- [ ] Run a final clean `npm ci && npm test && npm run build && npm run evals && npm pack --dry-run`.
- [ ] Confirm clean status and no private paths, raw prompts/outputs, session content, tokens, or secrets in tracked files or package contents.
