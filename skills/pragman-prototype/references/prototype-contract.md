# Prototype contract

## Required brief

- Decision to unlock
- Intended user and moment
- Riskiest assumption
- Smallest complete flow
- Success signal and stop condition
- Approved context sources and sensitivity
- Explicit non-goals

## Artifact invariants

The default artifact is one self-contained `.html` file with no external fonts, images, scripts, stylesheets, telemetry, or network calls. It has a descriptive title, semantic landmarks, a skip link, keyboard-visible controls, responsive layout, reduced-motion support, escaped imported text, valid local targets, and a visible “prototype—not production” notice.

Variants must test distinct hypotheses. Cosmetic permutations without a decision trade-off are noise.

## Feedback record

Capture:

```json
{
  "decision": "Keep | Change | Stop",
  "reason": "Why this direction should continue or change",
  "next_uncertainty": "The next assumption worth testing",
  "artifact_digest": "Digest or stable artifact reference"
}
```

Feedback controls inside the portable artifact are local-only. Persist feedback only through a separately approved workflow.

## Promotion boundary

Promotion creates an implementation-ready task contract; it does not promote prototype source. Include behavior, state transitions, accessibility expectations, data contracts, design constraints, acceptance evidence, non-goals, risks, and recommended provider route.
