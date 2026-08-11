# Routing contract

## Required route input

`request`, `task_family`, `desired_outcome`, `deliverable_kind`, `execution_mode`, `declared_side_effects`, `data_inputs`, `egress_destinations`, `urgency`, `uncertainties`, `scope_systems`, `estimated_sessions`, `downstream_impact`, `reversibility`, and `requested_capabilities` are required. `workspace` and `project` may be null.

Task families are `explain`, `research`, `shape`, `prototype`, `implement`, `debug`, `review`, `analyze`, `operate`, or `administer`. Deliverables are `response-only`, `local-artifact`, `project-change`, or `external-action`. Execution is `serial` or `independent-fanout`.

Each data input carries an ID, source alias, category, and sensitivity (`public`, `internal`, `confidential`, or `restricted`). Each uncertainty carries an ID, description, and `low`, `medium`, or `high` impact. Declare the requested outcome, not merely intermediate tool use.

## Task contract review

Verify one route ID, parent route when nested, request digest, lane, scope/non-scope, assumptions, unresolved conflicts, capabilities, ordered providers, sequence policy, side effects, sanitized data aliases, effective sensitivity, egress approvals, proof, stop conditions, and creation time.

The explanation must state required capabilities before it names candidate or selected providers. Only after capabilities are explicit may it include lane reasons, matched rule IDs, eligible provider scoring, rejection reasons, sequence truncation, and fallback state. Equal scores use deterministic tie-breaking, never conversational preference.

## Approval boundary

Read-only low-risk work can proceed automatically. Require the relevant route/egress/action/target/host approval for meaningful mutation, sensitive egress, material assumptions, unexpected workflow weight, credentials, destructive or paid actions, deployment, messages, purchases, external-account changes, and production/live-data writes.

An approval to route is not approval to perform a later live mutation.
