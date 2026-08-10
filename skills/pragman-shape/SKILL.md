---
name: pragman-shape
description: Use when an idea or request is vague, oversized, premature, low-evidence, or needs to become a decision, experiment, prototype, issue, spec, or implementation-ready task.
---

# Pragman Shape

Turn an ambiguous opportunity into the smallest valuable, testable contract. Preserve uncertainty where evidence is weak and prevent solution detail from outrunning the problem.

## Workflow

1. Name the problem, intended user, triggering situation, and why it matters now. Separate observed evidence from assumptions and requested solutions.
2. Ask focused questions only where the answer can change the desired outcome, smallest bet, kill criterion, safety boundary, or provider route. Use a configured brainstorming or product specialist through `pragman-router` when it adds leverage.
3. State the desired outcome as a change in user or system behavior, not a feature list. Identify explicit non-goals and the current baseline.
4. Choose the smallest valuable experiment or deliverable that can resolve the highest-risk assumption. Prefer a reversible slice with a short learning loop over a broad foundation.
5. Define success evidence, failure evidence, and a kill criterion before implementation. Include a time/cost box and what happens if the result is inconclusive.
6. Map dependencies, constraints, affected systems, privacy/egress, irreversible decisions, and downstream risks. Split work when independent outcomes or approval boundaries differ.
7. Recommend an execution lane and capability contract using [references/shape-contract.md](references/shape-contract.md). Route only after the task boundary is coherent; disclose fallback or manual handoff.
8. Present the shaped contract for confirmation. Do not begin implementation merely because the shape is plausible.

## Output

Return problem and intended user, evidence and assumptions, desired outcome, smallest valuable bet, non-goals, success and kill criteria, dependencies and risks, recommended lane/provider route, unresolved decisions, and the exact approval needed next.

## Guardrails

- Do not turn the user's first solution into the problem statement.
- Do not make a roadmap-sized request look executable by adding detail.
- Do not invent evidence or suppress low confidence.
- Do not omit kill criteria because a bet sounds strategically attractive.
- Do not route or implement work whose authority, side effects, or context boundary remains ambiguous.
