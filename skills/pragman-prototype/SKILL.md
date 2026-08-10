---
name: pragman-prototype
description: Use when a product, workflow, or UI decision will improve by seeing and clicking a disposable artifact before committing to production implementation.
---

# Pragman Prototype

Turn uncertainty into something the user can inspect, click, and decide on. A prototype is a decision artifact, not an early production implementation.

## Workflow

1. State the decision the prototype must unlock, the intended user, the riskiest assumptions, and the smallest flow that can test them. Ask only questions whose answers materially change the flow or safety boundary.
2. Load only the approved project taste, brand, accessibility, and workflow references. Preserve their sensitivity. Do not embed confidential text, credentials, private URLs, analytics, third-party scripts, or remote assets in a shareable artifact.
3. Decide whether a specialist adds value. Route through `pragman-router` when design systems, visual exploration, browser QA, or another installed capability is useful. Keep the route bounded to the stated decision.
4. Create one self-contained HTML flow by default. Add variants only when each represents a meaningful decision alternative; label the hypothesis and trade-off for every variant.
5. Use [assets/prototype.html](assets/prototype.html) as the portable fallback, or the deterministic report renderer when the Pragman runtime is available. Follow [references/prototype-contract.md](references/prototype-contract.md).
6. Preview locally. Exercise every control, keyboard path, responsive breakpoint, landmark, and feedback action. Confirm there are no network requests or broken targets.
7. Ask for structured feedback: `Keep`, `Change`, or `Stop`, followed by the reason and the next uncertainty. Iterate only on feedback that improves the decision.
8. When a direction is approved, produce a shaped task contract covering behavior, constraints, acceptance evidence, non-goals, and reusable project context. Do not copy prototype code into production by default.

## Output

Return the artifact location, decision being tested, included flow and variants, assumptions intentionally omitted, local preview instructions, validation performed, and the exact next decision requested from the user. Label the artifact visibly as a prototype.

## CLI unavailable

Create a self-contained HTML file from the bundled asset and explain how to open it locally. Disclose that deterministic packaging and report linking are unavailable. Never install dependencies or start a server without permission.

## Guardrails

- Default to one decisive flow, not a miniature product.
- No network, telemetry, forms that transmit, or external assets unless explicitly approved and declared.
- Escape imported content and use synthetic data when real data is unnecessary.
- Never treat visual polish as evidence of product validity.
- Do not mutate production code, configuration, or external systems while prototyping unless separately approved.
