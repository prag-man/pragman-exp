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

The deterministic CLI bridge is content-free and approval-bound:

1. `pragman sessions analyze --file ANALYSIS.json --state-root <events>` previews an optional `candidate` proposal only after the focused context questions are answered and the session evidence is not report-only. Repeat it with `--apply <candidate_creation.preview_digest>` to append the pending candidate; this does not approve it or tune anything.
2. Review with `pragman events candidates list`, then record the separate decision with `pragman events candidates decide`.
3. Run candidate-bound evidence with `pragman eval run`, then use `pragman tune` to preview and separately apply the verified private overlay. A current, journal-verified overlay contributes a personal routing preference only while the installed skill digest still matches the evaluated digest.
4. Use the returned tune `change_id` with `pragman changes rollback --change <id>`. Preview first, then repeat with `--apply <preview_digest>`; rollback restores the exact snapshot referenced by the tune journal. `pragman changes list` exposes tune history under `tune_changes`.

An approved eval-candidate is eligible input to the tuning preview only. Verify the approved candidate and artifact digests. Pending, rejected, missing, or drifted records never enter a tune preview.

Prepare reusable public learning separately. Sanitize company names, paths, prompts, source code, credentials, customer data, and session excerpts; require a distinct review and publication authorization.
