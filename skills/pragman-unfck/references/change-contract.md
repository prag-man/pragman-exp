# Diagnosis and change contract

## Causal framing

For each finding, record:

- `Symptom`: observed undesirable result, with evidence aliases.
- `Contributing factors`: conditions that plausibly increased its likelihood.
- `Likely root cause`: the deepest supported, actionable explanation.
- `Confidence`: low, medium, or high; explain missing evidence.
- `Counter-evidence`: successful or contradictory observations.

Do not promote a symptom such as elapsed time, retries, or compactions into a root cause. A provider mismatch, unclear task boundary, missing credential, or oversized scope is causal only when evidence plus user context support it.

## Change proposal

Each proposal needs target, exact sanitized diff, evidence references, expected impact, confidence, trade-off, success measure, evaluation set, rollback point, and `approval_required=true`.

Allowed targets are personal configuration, project configuration, and private workspace configuration or overlay. Never directly edit installed Pragman core or third-party skills.

Use this sequence:

1. Preview the exact diff without writing.
2. Ask the user to approve the preview.
3. Evaluate the affected behavior in isolation.
4. Show evaluation results and ask for apply approval again.
5. Apply atomically and append reversible history.
6. Review measured outcomes; keep or roll back.

An approved eval-candidate is eligible input to step 1 only. Verify the approved candidate and artifact digests. Pending, rejected, missing, or drifted records never enter a change preview.

Prepare reusable public learning separately. Sanitize company names, paths, prompts, source code, credentials, customer data, and session excerpts; require a distinct review and publication authorization.
