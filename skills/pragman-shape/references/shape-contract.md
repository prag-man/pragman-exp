# Shape contract

```yaml
problem:
  intended_user: ""
  triggering_situation: ""
  observed_problem: ""
evidence: []
assumptions: []
desired_outcome:
  behavior_change: ""
  baseline: ""
smallest_bet:
  deliverable: ""
  riskiest_assumption: ""
  time_or_cost_box: ""
non_goals: []
criteria:
  success: []
  kill: []
  inconclusive_next_step: ""
dependencies: []
risks: []
route:
  lane: "obvious-fast | adaptive-default | deep-deliberate | operational"
  requested_capabilities: []
  declared_side_effects: []
  egress_destinations: []
unresolved_decisions: []
approval_needed: ""
```

Evidence items carry a source alias and confidence. Assumptions state the cheapest test. Risks state likelihood, impact, mitigation, and owner when known.

Choose `prototype` when interaction or visual alternatives unlock the decision; `research` when evidence is missing; `implement` when behavior and acceptance evidence are settled; `operate` when the primary outcome changes external state. Split contracts when approval or reversibility boundaries differ.
