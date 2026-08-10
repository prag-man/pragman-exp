# Analysis contract

## Eleven required dimensions

1. Intent versus outcome
2. Scope and routing quality
3. Assumptions and decisions
4. Context completeness
5. Provider and tool fit
6. Time versus value
7. Rework, compactions, retries, and waits
8. Verification and quality
9. Human-agent collaboration
10. External blockers
11. Reusable learning

Every dimension must be present. “No evidence” or “not applicable” is valid when explained.

## Evidence and confidence

Use stable, sanitized aliases such as `event:route-12`, `test:router-golden`, `decision:scope-v2`, or `artifact:prototype-digest`. Confidence means support strength:

- `high`: directly observed and corroborated
- `medium`: supported but incomplete or dependent on a reasonable inference
- `low`: plausible hypothesis requiring a test or user context

Historical metrics with changed definitions are not comparable until reconciled. Preserve the evidence gap.

## Required action groups

- `Keep`: demonstrated patterns worth preserving
- `Change`: bounded adjustments with an expected benefit
- `Stop`: work whose cost or risk exceeds its value
- `Automate`: repeated deterministic work with a safe control boundary
- `Learn`: durable context or a principle worth recording
- `Test next`: hypotheses that need evidence before adoption

An empty group is allowed; omitting a group is not. Each action carries a rationale, evidence references, confidence, expected benefit, and trade-off. Recommendations never imply approval to mutate configuration.
