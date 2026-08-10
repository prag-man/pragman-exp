# Pragman Skill Events and Evaluation Design

**Date:** 2026-08-10

**Status:** User-approved and independently reviewed

**Parent spec:** `docs/superpowers/specs/2026-08-10-pragman-exp-design.md`

## 1. Decision

Pragman will use a local, content-free measurement system with five distinct records:

1. Immutable skill lifecycle events
2. Immutable scores attached after an outcome is known
3. Rebuildable daily and weekly rollups
4. Immutable real-failure evaluation candidates
5. Immutable candidate approval decisions

This makes the skill collection evidence-driven without adding a hosted service, background daemon, or transcript store. The system measures both routing quality and outcome lift. It never changes a skill, provider preference, or workspace automatically.

The design follows the evaluation principle demonstrated in “Don’t Ship Skills Without Evals”: a skill is useful only when repeated skill-on versus skill-off trials show better outcomes. It also separates immutable events from scores added later, uses low-cardinality event names, and treats duration-bearing work as an invocation rather than a single instantaneous event.

## 2. Alternatives considered

### 2.1 Append-only JSONL events only

This is the smallest implementation, but it cannot cleanly attach delayed verification or evaluator scores, and long-term analysis would repeatedly scan raw files. Rejected because it cannot support reliable ablation or longitudinal lifecycle decisions.

### 2.2 Local events, scores, and rollups — selected

Events preserve what happened, score records preserve how an outcome was judged, and rollups make trends cheap to inspect. All records remain local and content-free. This provides enough evidence for routing, regression detection, and skill retirement recommendations while preserving the approved local-first architecture.

### 2.3 Hosted telemetry and evaluation service

A hosted backend could aggregate across users, but it would introduce accounts, network egress, governance, availability, and privacy obligations that are outside v1. Rejected for v1. A future aggregate export may be designed separately and must remain explicit opt-in.

## 3. Boundaries

### 3.1 In scope

- Measure direct, routed, host-observed, and evaluation invocations when observable.
- Record skill identity, version, digest, environment dimensions, lifecycle, counters, and verification state.
- Attach deterministic, user, or disclosed LLM-judge scores after invocation.
- Compare skill-on and skill-off evaluation arms across repeated trials.
- Calculate activation precision/recall only when expected activation is known.
- Produce daily/weekly summaries, drift warnings, and review candidates.
- Feed approved, redacted real-world failures into per-skill evaluation corpora.
- Export aggregate records only after an explicit preview and approval.

### 3.2 Out of scope

- Raw prompts, responses, transcripts, source code, tool arguments, URLs, secrets, or private paths.
- Mandatory remote telemetry or cross-user benchmarking.
- Background collection, a daemon, or an always-running database.
- Inferring a direct skill invocation when no adapter observed it.
- Automatically changing, publishing, disabling, or deleting a skill.
- Product analytics unrelated to skill routing and work outcomes.

## 4. Storage layout

The private state root contains:

```text
~/.pragman/state/events/
  skill-events/YYYY-MM-DD.jsonl
  scores/YYYY-MM-DD.jsonl
  eval-candidates/YYYY-MM-DD.jsonl
  candidate-approvals/YYYY-MM-DD.jsonl
  rollups/daily/YYYY-MM-DD.json
  rollups/weekly/YYYY-Www.json
  quarantine/
```

JSONL files are append-only. Each line is a complete validated record. Durable event, score, candidate, and approval commands use the existing state-root advisory lock, append one canonical record through a file handle opened with append semantics, and sync it before releasing the lock. Best-effort instrumentation follows the bounded path in Section 10. A malformed or truncated tail is quarantined on the next read; earlier valid lines remain usable.

Rollups inside the raw-retention horizon are derived state. `pragman events rebuild` can reproduce them from retained events and scores. Before a raw day expires, retention rebuilds its daily rollup, verifies the source count and canonical source digest, marks it `sealed`, and only then purges that day's raw records. Sealed rollups are durable compacted history rather than rebuildable cache; rebuild verifies and preserves them. Weekly rollups are deterministically recomputed from daily rollups, including sealed days. No command edits or deletes an individual historical event.

## 5. Skill event contract

The existing `skill-event.schema.json` becomes the normative lifecycle record. It will be revised before storage implementation to require:

- `schema_version`, `event_id`, `invocation_id`, `timestamp`
- `event_type`: `eligible`, `invoked`, `completed`, `cancelled`, or `verified`
- `skill_id`, `skill_version`, `skill_digest`, `skill_type`
- `host`, `host_version`, `model`, `model_version`, `harness_version`
- `invocation_mode`: `model`, `user`, `router`, `host`, or `eval`
- nullable aliases: `session_id`, `route_id`, `eval_id`, `case_id`, `trial_id`
- nullable `provider`, `ablation_arm`, `trigger_expected`, and `trigger_actual`
- nullable `provider_digest`, `eval_corpus_digest`, and `trial_policy_digest`
- nullable `status` and `outcome_code`
- non-negative counters: `duration_ms`, `tool_calls`, `retries`, `rework_cycles`, `verification_checks`, `verification_passes`
- `observation_source`: `router`, `host-adapter`, `cli`, `eval-runner`, or `user-report`
- `source_aliases`, `storage_scope=local`, and `append_only=true`

Event fields are enums, bounded identifiers, booleans, hashes, timestamps, or non-negative numbers. Arbitrary descriptive text is forbidden. Event names and IDs are low-cardinality; unique invocation identity belongs in `invocation_id`, never in the event name.

Lifecycle validation enforces:

- `invoked` begins an invocation.
- `completed` or `cancelled` terminates execution and may carry duration/counters/status.
- `verified` may arrive later and carries verification counters plus an outcome code.
- Duplicate `event_id` is idempotent only when the full canonical record digest matches; otherwise it is an identity collision and is quarantined.
- Missing intermediate events do not create synthetic success. Coverage reports the incomplete lifecycle.

`eligible` is emitted only when a router or eval runner evaluated a named skill candidate. It is not interpreted as an invocation.

## 6. Score contract

A `skill-score` record is immutable and requires:

- `schema_version`, `score_id`, `timestamp`
- `invocation_id` and optional `eval_id`, `case_id`, `trial_id`
- `metric_id`, `metric_definition_digest`, and `value`
- `value_type`: `boolean`, `number`, or `category`
- `source`: `deterministic`, `user`, or `llm-judge`
- `grader_id`, `grader_version`, and `rubric_digest`
- `evidence_digests` and `storage_scope=local`
- optional `supersedes_score_id`

Numbers use a published metric range. Categories use a metric-specific enum. User scores record the explicit rating but never the feedback text. LLM-judge scoring requires a versioned public rubric, disclosed remote egress, and only the minimum approved artifact. Stored evidence is digest-only.

For deterministic scoring, `rubric_digest` equals the metric-definition digest and `grader_id` names the executable grader. For user scoring, the public user-rating rubric digest and a fixed `user-rating` grader/version are recorded. For LLM judges, `rubric_digest` identifies the exact disclosed judge prompt and anchors.

A correction appends a new score referencing the old record. It never mutates the prior score. Rollups use the latest valid score in each supersession chain and report the correction count.

Corrections form a linear chain. A referenced predecessor must already exist and be retained, have an earlier timestamp, and match `invocation_id`, `metric_id`, `metric_definition_digest`, `value_type`, `source`, `grader_id`, `grader_version`, and `rubric_digest`. A predecessor may have at most one successor; a missing predecessor, cycle, fork, or identity mismatch quarantines the proposed correction. Retention is anchored to the invocation's `invoked` timestamp and purges the event plus its complete score chains together, so a delayed score cannot extend or outlive the invocation cohort. A score for an expired or unknown invocation is rejected.

### 6.1 Metric definition contract

Every scored metric has a versioned public definition under `evals/metrics/` and a canonical digest recorded on each score. A definition requires:

- `schema_version`, `metric_id`, `version`, and `description`
- `value_type`: `boolean`, `number`, or `category`
- exactly one value domain: `number_range { min, max }`, `boolean_values`, or ordered `categories`
- `direction`: `maximize`, `minimize`, or `target`
- `pass_rule` using `eq`, `gte`, `lte`, or inclusive `between`
- `eligible_score_sources`: a non-empty subset of `deterministic`, `user`, and `llm-judge`
- `eligible_verification_codes`: the bounded outcome codes allowed in verified-success denominators, or an empty list when the metric does not support verified success
- `lifecycle_policy`: deterministic recommendation thresholds in the metric's published units

Boolean definitions assign each value a utility from 0 through 1. Category definitions assign each category a stable ID, ordinal rank, pass/fail value, and utility from 0 through 1. A target numeric metric declares its target or inclusive target range. Schema validation rejects a score outside the domain, from an ineligible source, or against an unknown definition digest. Reliability and regression use the definition's pass rule and normalized utility; implementations never infer them from the metric name.

Every value maps deterministically to utility in `[0,1]`, where higher is always better:

- `maximize` number: `(value - min) / (max - min)`
- `minimize` number: `(max - value) / (max - min)`
- point-target number: `1 - min(1, abs(value - target) / max(target - min, max - target))`
- inclusive-range target: utility 1 inside; below it use `1 - min(1, (target_min - value) / (target_min - min))`; above it use `1 - min(1, (value - target_max) / (max - target_max))`
- boolean/category: the definition's explicit utility for that value

Numeric domains require `max > min`; target denominators must be positive. Ablation reports raw metric deltas for display and `utility_lift = mean(skill-on utility) - mean(skill-off utility)`. All lifecycle policies use utility/pass-rate/efficiency values, never raw direction-dependent lift.

`lifecycle_policy` requires:

- `minimum_trials_per_arm` from 2 through 20
- `minimum_comparable_environments` from 1 through 10
- `minimum_pass_rate` from 0 through 1
- `regression_tolerance`, `material_lift`, and `non_inferiority_margin` from 0 through 1 in normalized utility units
- `efficiency_materiality` with non-negative thresholds for `duration_ms`, `retries`, `rework_cycles`, and `tool_calls`

Recommendations apply these values exactly: regression means comparable current mean utility declines beyond `regression_tolerance`; drift means an environment/digest changed and has fewer than `minimum_trials_per_arm` current trials; improve means pass rate is below `minimum_pass_rate`; retire requires a capability skill, at least `minimum_comparable_environments`, utility lift no greater than `non_inferiority_margin`, and no efficiency improvement exceeding its materiality threshold in every environment; retain preference requires preference-adherence utility lift of at least `material_lift`; reactivate requires a previously retired capability and current utility lift greater than `material_lift`. Insufficient or incomparable evidence produces no lifecycle recommendation except drift.

### 6.2 Real-failure candidate approval

An observed failure may create a content-free `eval-candidate`. It requires `schema_version`, UUIDv7 `candidate_id`, timestamp, target `skill_id`/`skill_digest`/`corpus_id`, one or more source-event digests, optional recommendation digest, bounded slug `failure_codes`, redacted-artifact alias/digest, `approval_status=pending`, `storage_scope=local`, and `append_only=true`. Unknown fields and arbitrary prompt/output/transcript text are rejected. It cannot write a corpus.

Approval is a separate immutable `eval-candidate-approval` record requiring `schema_version`, UUIDv7 `approval_id`, timestamp, candidate ID/digest, decision `approved` or `rejected`, `approval_source=user`, reviewed redacted-artifact digest, `storage_scope=local`, and `append_only=true`. A candidate has at most one decision. Exact duplicate IDs/records are idempotent; divergent duplicate IDs, missing candidates, a changed candidate/artifact digest, or a second/conflicting decision are quarantined. Even an approved candidate grants only eligibility for the later unfck preview/eval/apply flow, not direct corpus mutation.

## 7. Metrics

Pragman reports denominators with every rate and never compares incomparable cohorts.

### 7.1 Routing metrics

- Activation precision: expected-and-invoked / all invoked cases where expectation is known.
- Activation recall: expected-and-invoked / all expected cases.
- No-op accuracy: not-expected-and-not-invoked / all not-expected cases.
- Route acceptance and explicit override rate.
- Observable invocation coverage by observation source.

Production invocations normally have `trigger_expected=null`; they do not enter precision, recall, or no-op accuracy.

### 7.2 Outcome metrics

- Completion status counts.
- Verified success: invocations with a passing deterministic or explicitly accepted user verification divided by completed invocations eligible for that verifier.
- Rework, retry, tool-call, verification, and duration distributions.
- Mean and distribution of published score metrics.
- Reliability: fraction of evaluation cases meeting their threshold across the required repeated trials.

### 7.3 Ablation metrics

An ablation comparison requires the same `eval_id`, `eval_corpus_digest`, `trial_policy_digest`, case and paired-trial IDs, skill digest under test, provider and provider digest, host and host version, model and model version, harness version, metric definition digest, grader/grader version, and rubric digest for both arms. Both arms record the tested skill's provider record and digest; `skill-off` marks that skill as the omitted intervention rather than replacing its provider identity with an unrelated baseline. Pragman reports:

- Outcome lift: mean skill-on score minus mean skill-off score.
- Direction-normalized utility lift.
- Verified-success lift.
- Duration, retries, rework, and tool-call deltas.
- Confidence interval or, for fewer than 20 paired trials, the raw paired results without a significance claim.

Missing arms, changed rubrics, or incomparable environments produce `INCOMPARABLE`, not a zero lift.

## 8. Rollups and lifecycle recommendations

Daily and weekly rollups group only by bounded dimensions: skill identity/version/digest/type, host/model/harness and their versions, invocation mode, provider/provider digest, event cohort, eval corpus/trial-policy digest, metric-definition/rubric digest, and ablation arm. They contain counts, sums, bounded histograms, score aggregates, source-coverage counts, source-record count/digest, and `sealed` state—never source aliases or invocation/session identifiers.

Pragman can generate review candidates:

- **Regression:** a current comparable cohort falls below its published release threshold.
- **Drift:** the host, model, harness, skill digest, provider digest, or rubric changed and lacks enough current trials.
- **Improve:** repeated failures or low activation quality identify an evidence-backed gap.
- **Retire capability skill:** baseline performance is non-inferior across the skill's supported environments and the skill adds no material quality, reliability, or efficiency lift.
- **Retain preference skill:** it materially improves adherence to explicit user/workspace preferences even when capability lift is neutral.
- **Reactivate:** a retired capability regains meaningful lift after environment drift.

These are recommendations shown by `pragman analyze` or `pragman unfck`. Applying any configuration or skill change still requires preview, evaluation, and user approval under the parent spec.

## 9. Retention and privacy

Local skill measurement is enabled by default because it stores no work content. It is configured separately as `measurement.local_events`; the existing `telemetry.enabled=false` default continues to mean remote telemetry is disabled. No remote endpoint exists in v1.

Defaults:

| Record | Retention |
| --- | --- |
| Raw skill events and complete score chains | 180 days from invocation |
| Evaluation candidates and approval decisions | 180 days from candidate creation |
| Daily rollups | 2 years |
| Weekly rollups | until user purge |
| Quarantined invalid records | 30 days |
| Raw prompts, outputs, transcripts, paths, tool arguments | never stored |

Users may disable local events, shorten retention, rebuild rollups, preview a purge, or purge all records. Disabling measurement does not prevent any skill from running. Purges are explicit destructive operations and report the exact time range and record classes.

Automatic expiry follows compact-before-delete: seal and verify the daily rollup, recompute the affected weekly rollup, then remove the raw invocation cohorts. Candidate expiry removes the candidate and its complete decision set together; no rollup is required. If sealing or verification fails, raw records remain and doctor reports retention debt. A user-requested purge may deliberately remove raw, candidate/approval, and/or compacted history after its preview; it does not pretend the deleted period remains rebuildable.

`pragman events export` defaults to rollups. Exporting raw content-free events requires a second explicit choice and preview. Session IDs, route IDs, source aliases, and invocation IDs are omitted or replaced with export-local cohort IDs. Evaluation candidates, artifact aliases/digests, and approval decisions are never exported in v1. The export includes its schema version and aggregation policy.

## 10. Instrumentation

Instrumentation occurs at the nearest trustworthy observer:

- Router records candidate eligibility and routed invocations.
- Host adapters record direct invocations only when the host exposes a reliable hook.
- CLI-owned workflows record their own invocations.
- Eval runner records both ablation arms and trial identity.
- Skill instructions may request a best-effort CLI record only when no adapter exists; failure is silent apart from a local doctor warning.

The system never claims complete coverage. Every summary includes observed invocation count by source and incomplete lifecycle count.

Event recording must not block the user's primary workflow. The library exposes two explicit modes:

- `durable`: used only when recording is the command's requested primary outcome. It waits for the mutation lock, append, and sync under the normal CLI temporary-failure rules.
- `best-effort`: used by router, host adapter, and skill instrumentation. It validates in memory, attempts the lock for at most 5 ms, and races append completion against a 20 ms total wall-clock deadline. It does not sync. Lock contention, deadline, validation, or I/O failure returns `recorded=false` plus a bounded reason code; the observer proceeds without retrying on the primary path.

The append worker owns and releases any acquired lock in `finally`; an append still completing after the caller's deadline retains that lock until it settles but cannot alter the returned work result or trigger a primary-path retry. Tests inject a stalled lock and stalled append and require the observer to return within 30 ms under a monotonic fake clock. A warning is returned to the invoking adapter and contributes to in-process coverage diagnostics when possible. Security denials reject only the event, not the work.

## 11. CLI surface

```text
pragman events record
pragman events score
pragman events list
pragman events summary
pragman events rebuild
pragman events export
pragman events purge
pragman events candidates list
pragman events candidates decide
pragman eval run
pragman eval compare
```

`record` and `score` accept validated JSON on standard input or a file path; sensitive values never appear in command arguments. Human output is concise, while `--json` uses the parent spec's stable envelope and exit classes. Mutating retention/export operations support preview and digest-bound apply.

## 12. Evaluation policy

Every mature skill release contains approximately 10–20 representative prompts, scaled down only while a new skill is still being developed. Its corpus includes:

- positive activation cases
- negative/no-op cases
- edge and pressure cases
- approved, anonymized real failure trajectories

Each release evaluation runs 2–6 trials per case according to the skill's published trial policy. Capability skills require skill-on/skill-off ablation. Preference skills require preference-adherence scoring and include a no-skill baseline when meaningful. Host support claims require tests on that host; simulated adapter tests cannot substitute for the required live release smoke test.

Deterministic graders are preferred in this order: schema, exact invariant, parser/AST, executable test, then rubric. An LLM judge is used only when semantic quality cannot be determined reliably by code.

A skill change may merge when:

- every privacy, security, approval, and deterministic invariant passes;
- no supported cohort regresses beyond its published tolerance;
- the target metric improves, or the change adds meaningful failure coverage without regression; and
- baseline and forward results, corpus/trial-policy digests, full comparable environment versions, skill/provider digests, metric-definition digest, and rubric digest are recorded.

## 13. Acceptance criteria

- Event, score, and rollup schemas reject arbitrary text and known secret formats.
- Lifecycle storage is append-only, idempotent for exact duplicates, collision-safe, lock-safe, and recoverable from a truncated final line.
- Best-effort instrumentation returns inside its bounded deadline under lock and append stalls, while durable event commands preserve sync semantics.
- Delayed and corrected scores preserve history and rollups select the latest valid correction.
- Metric definitions normatively define domains, direction, pass rules, and eligible verifiers.
- Metric lifecycle policies normatively define recommendation evidence and materiality thresholds.
- Skill-on/off comparison rejects mismatched corpora, environments, graders, or trial policies.
- Precision/recall exclude production cases whose expectation is unknown.
- Summaries expose denominators, observation coverage, incomplete lifecycles, and cohort dimensions.
- Event failures never fail an otherwise valid skill invocation.
- Export is local, previewed, aggregate-first, and contains no private identifiers or content.
- Retention seals and verifies rollups before raw expiry; rebuild preserves sealed history, and purge behavior is deterministic and test-covered.
- Analyze/unfck recommendations remain advisory until preview, evaluation, and user approval.
- Real-failure candidates require an immutable digest-bound user decision and still cannot write a corpus directly.
- At least one end-to-end fixture demonstrates: route → invoke → complete → verify → score → roll up → ablation comparison → improvement recommendation.

## 14. Research basis

- [“Don’t Ship Skills Without Evals”](https://www.youtube.com/watch?v=0vphxNt4wyk), Philipp Schmid, AI Engineer 2026.
- [OpenTelemetry event semantic conventions](https://opentelemetry.io/docs/specs/semconv/general/events/) for named state-change events and low-cardinality names.
- [Langfuse scores](https://langfuse.com/docs/evaluation/scores/overview) for attaching evaluation scores to immutable execution records.

This document is additive. Where it conflicts with the parent spec's generic telemetry, metric, retention, CLI, or delivery-unit language, this narrower skill-events design governs v1 skill measurement.
