---
name: pragman-workspace
description: Use when creating, inspecting, linking, changing, or validating reusable personal, company, client, venture, or project context; keep one-off facts in the current request.
---

# Pragman Workspace

Keep reusable context useful without blending organizations or exposing source content. A project has one primary workspace; explicitly ordered additional workspaces are advisory and never silently override it.

## Use this skill when

- You work across clients, companies, ventures, or projects and need durable context without cross-boundary leakage.
- A project needs one explicit primary workspace plus deliberately ordered advisory context.
- Context sources, privacy, ownership, links, or conflicts should be validated before an agent relies on them.

## Acceleration payoff

It prevents repeated context dumps and wrong-tenant assumptions by making reusable context indexed, layered, attributable, and reversible.

## Workflow

1. Identify the context boundary: personal, workspace, or linked project. Ask only for missing answers that change ownership, primary workspace, additional-workspace order, sensitivity, or canonical sources.
2. Inventory context by reference. Record a source ID, kind, locator, description, and sensitivity (`public < internal < confidential < restricted`). Do not copy a private corpus into configuration, chat, evals, or public artifacts. Never store credentials.
3. Choose exactly one primary workspace for a project. Attach additional workspaces only when the task needs them, in deliberate order. Treat their facts and provider rules as candidates; surface conflicts with source aliases and request a choice.
4. Locate `pragman` through the executable path and verify `pragman --version --json` is compatible. Read [references/workspace-model.md](references/workspace-model.md) before constructing files or commands.
5. Preview every mutation. Show the target alias, operation summary, privacy impact, and digest. Apply only after explicit approval using the unchanged digest; never interpret a preview as a write.
6. Run `workspace validate` after apply. Report the active layer, primary and additional workspace IDs, unresolved conflicts, and provenance—never raw roots, source URIs, or source text.

Use capability `pragman.route` after context is valid. Keep project-specific conventions in the project; keep company/client context in its workspace; keep preferences that cross all work in personal context.

## CLI unavailable

Disclose that schema validation, digest binding, atomic writes, link integrity, audit snapshots, and rollback guarantees are unavailable. Draft the proposed YAML and context index for review, but do not write or claim validation. Offer `npm install --global @prag-man/pragman-exp@beta` for the current prerelease; never install automatically.

## Guardrails

- Do not merge unrelated companies or clients.
- Do not resolve additional-workspace conflicts by list order.
- Do not turn a directory into a context dump; index canonical sources.
- Do not expose absolute paths or sensitive source contents in summaries.
- Stop on a newer schema, root mismatch, stale digest, symlink escape, or secret-like value.
