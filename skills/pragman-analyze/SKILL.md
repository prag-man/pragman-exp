---
name: pragman-analyze
description: Use after a project, decision, incident, experiment, release, or workflow to explain outcomes from evidence and choose the highest-leverage next improvements.
---

# Pragman Analyze

Produce a decision-grade analysis grounded in observable evidence. A good result preserves successful patterns, identifies causes without hindsight theater, and turns learning into explicit options—not silent configuration changes.

## Use this skill when

- Work finished, stalled, or drifted and the next iteration should learn from what actually happened.
- You have artifacts, diffs, tests, decisions, event aggregates, or carefully bounded user context to compare with the intended outcome.
- You need explicit Keep/Change/Stop/Automate/Learn/Test next actions rather than a generic retrospective.

## Acceleration payoff

It turns expensive rework into reusable operating learning while keeping confidence, evidence gaps, and trade-offs visible.

## Workflow

1. Define the subject, intended outcome, time boundary, systems and people in scope, and decision this analysis should enable. Distinguish successful, drifted, blocked, and incomplete work. For expanded work, classify each addition as necessary discovery, an approved scope change, or avoidable drift against the original decision boundary and contemporaneous decisions. If that evidence is missing, leave the classification unresolved.
2. Build an evidence index before interpreting. Prefer artifacts, diffs, tests, event aggregates, decisions, timestamps, and user-supplied context. Reference sensitive evidence by alias; do not copy private source bodies into the report.
3. Separate observed fact, sourced context, and inference. Attach `low`, `medium`, or `high` confidence to every material claim. Record missing evidence instead of inventing certainty.
4. Analyze every dimension in [references/analysis-contract.md](references/analysis-contract.md). Preserve both strengths and failures; a successful outcome can still contain waste, and a blocked outcome can still reveal a good decision.
5. Identify symptoms, contributing conditions, and likely root causes. Compare time and rework against value delivered. Avoid blaming an agent, provider, or user when the evidence only establishes correlation.
6. Group recommendations under exactly `Keep`, `Change`, `Stop`, `Automate`, `Learn`, and `Test next`. Give each action a rationale, evidence references, confidence, expected benefit, and meaningful trade-off.
7. Render a readable Markdown report and structured JSON when the Pragman runtime is available. Sanitize all output and disclose evidence gaps.
8. Stop at recommendations. If the user wants a change, transition to the appropriate workspace/tuning workflow, show an exact preview, evaluate it, obtain approval, then apply reversibly.

## Output

Lead with the outcome and the few highest-leverage findings. Include scope, evidence coverage, all eleven dimensions, root-cause framing, exact action groups, confidence, unresolved questions, and the next decision. If work is still in flight, say so and avoid treating temporary waits as final failures.

## CLI unavailable

Produce the same evidence index and Markdown structure manually. Disclose that deterministic JSON validation, aggregate event loading, comparable-metric checks, and report rendering were not performed. Do not claim measured improvement or mutate configuration from an unvalidated report.

## Guardrails

- Do not turn a retrospective into generic advice detached from evidence.
- Do not infer intent solely from logs when the user can supply missing context.
- Do not expose prompts, session text, paths, credentials, or private source bodies.
- Do not automatically modify skills, routing, workspace configuration, or external systems.
- Do not rank people or agents from sparse or incomparable samples.
