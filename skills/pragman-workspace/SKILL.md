---
name: pragman-workspace
description: Use when creating, inspecting, linking, changing, or validating personal, company, client, venture, or project context; not for one-off facts that should remain only in the current request.
---

# Pragman Workspace

Keep reusable context useful without blending organizations or exposing source content. A project has one primary workspace; explicitly ordered additional workspaces are advisory and never silently override it.

## Workflow

1. Identify the context boundary: personal, workspace, or linked project. Ask only for missing answers that change ownership, primary workspace, additional-workspace order, sensitivity, or canonical sources.
2. Inventory context by reference. Record a source ID, kind, locator, description, and sensitivity (`public < internal < confidential < restricted`). Do not copy a private corpus into configuration, chat, evals, or public artifacts. Never store credentials.
3. Choose exactly one primary workspace for a project. Attach additional workspaces only when the task needs them, in deliberate order. Treat their facts and provider rules as candidates; surface conflicts with source aliases and request a choice.
4. Locate `pragman` through the executable path and verify `pragman --version --json` is compatible. Read [references/workspace-model.md](references/workspace-model.md) before constructing files or commands.
5. Preview every mutation. Show the target alias, operation summary, privacy impact, and digest. Apply only after explicit approval using the unchanged digest; never interpret a preview as a write.
6. Run `workspace validate` after apply. Report the active layer, primary and additional workspace IDs, unresolved conflicts, and provenance—never raw roots, source URIs, or source text.

Use capability `pragman.route` after context is valid. Keep project-specific conventions in the project; keep company/client context in its workspace; keep preferences that cross all work in personal context.

## CLI unavailable

Disclose that schema validation, digest binding, atomic writes, link integrity, audit snapshots, and rollback guarantees are unavailable. Draft the proposed YAML and context index for review, but do not write or claim validation. Offer `npm install --global @prag-man/pragman-exp`; never install automatically.

## Guardrails

- Do not merge unrelated companies or clients.
- Do not resolve additional-workspace conflicts by list order.
- Do not turn a directory into a context dump; index canonical sources.
- Do not expose absolute paths or sensitive source contents in summaries.
- Stop on a newer schema, root mismatch, stale digest, symlink escape, or secret-like value.
