---
name: pragman-research
description: Use when a decision or deliverable needs current external, technical, market, competitive, internal-workspace, or multi-source evidence.
---

# Pragman Research

Research starts with the decision it must enable. Match effort to consequence, use the strongest available sources, and finish with an actionable synthesis rather than a reading list.

## Workflow

1. Define the decision, audience, deliverable, deadline, required freshness, acceptable uncertainty, and excluded scope. Ask only for missing constraints that materially change method, access, privacy, or cost.
2. Select the lightest sufficient method from [references/research-methods.md](references/research-methods.md). Use independent fan-out only when lanes do not depend on one another and their outputs can be reconciled deterministically.
3. Route needed capabilities through `pragman-router`. Reuse configured research, browser, repository, and workspace providers. If no compatible provider is healthy, disclose the limitation and use the native/manual fallback; never imply a search or connector call occurred when it did not.
4. Declare the source plan and egress boundary before retrieval. Search only approved sources and connectors. Never upload internal or sensitive material to an external provider without explicit approval.
5. Prefer primary, authoritative, and current evidence. Record source, publication/event date, retrieval date, direct support, and important limitations. For technical research, official documentation and original papers outrank summaries.
6. Keep sourced fact, source claim, and inference distinct. Triangulate high-impact claims, preserve meaningful disagreement, and state when freshness or access makes an answer provisional.
7. Stop when the decision threshold is met or additional research has lower expected value than acting or testing. Do not confuse more sources with greater confidence.
8. Deliver the answer first, followed by evidence, disagreements, confidence, gaps, and recommended action. Link directly to sources when the host supports it.

## Method shortcuts

- Quick reconnaissance: establish vocabulary, current state, and whether deeper work is justified.
- Technical source-first: inspect official specifications, code, changelogs, papers, and primary issue trackers.
- Deep multi-source: build a claim ledger and triangulate material findings across source types.
- Independent fan-out: split bounded questions, run concurrently, then reconcile duplicates and conflicts.
- Decision research: compare realistic alternatives against explicit criteria and switching costs.
- Internal workspace: use configured source aliases with tenant/company boundaries and least privilege.

## CLI unavailable

Use the host's approved research tools or user-supplied evidence and keep the same source/evidence contract. Disclose that deterministic provider routing, connector health checks, and local evidence indexing were not performed. Do not install providers or imply access to unavailable sources.

## Guardrails

- Browse when freshness matters; say when browsing or a connector is unavailable.
- Do not cite search-result pages as evidence when a direct source exists.
- Do not fabricate citations, quotes, access, consensus, or recency.
- Keep private source bodies out of public reports and evals.
- Treat provider output as evidence to verify, not authority to repeat.
