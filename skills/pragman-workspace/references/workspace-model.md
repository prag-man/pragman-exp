# Workspace model and CLI contract

## Layers

Resolution is field-by-field: explicit request → project → primary workspace → personal → defaults. `prohibitions`, `require_capabilities`, and `context_sources` accumulate as ordered sets. Additional workspaces append source references in explicit order but cannot override primary scalars.

## Records

A workspace needs `schema_version`, `workspace_id`, `name`, normalized absolute `root`, and `context_sources`. Each source needs `id`, `kind`, `uri`, `description`, and `sensitivity`. Prefer relative locators for files and directories inside the workspace root.

A project manifest needs `schema_version`, `project_id`, one primary `workspace`, and its normalized absolute `root`. `additional_workspaces` is an ordered unique list and must not repeat the primary. The default context index is `.pragman/context-index.yaml`.

Example workspace input:

```json
{
  "schema_version": 1,
  "workspace_id": "acme",
  "name": "Acme",
  "root": "/approved/acme",
  "context_sources": [
    {"id":"canonical-docs","kind":"directory","uri":"docs","description":"Canonical operating docs","sensitivity":"internal"}
  ],
  "sensitivity": "internal"
}
```

## Commands

Use `--config <personal-root>` and JSON through stdin or `--file`.

```text
pragman workspace add --config <root> --preview --json
pragman workspace add --config <root> --apply <digest> --json
pragman workspace edit --config <root> --workspace <id> --preview --json
pragman workspace list --config <root> --json
pragman workspace link --config <root> --project-root <path> --preview --json
pragman workspace unlink --config <root> --project-root <path> --preview --json
pragman workspace validate --config <root> --project-root <path> --json
```

Edit input is `{ "operations": [...], "reason": "..." }` using `add`, `replace`, or `remove` JSON Patch operations. Workspace identity and root are immutable; create a new workspace instead.

Link input contains `project_id`, `workspace`, and optional ordered `additional_workspaces`, `product`, or `context_index`. Apply repeats the identical input with `--apply <preview_digest>`.

## Privacy and conflicts

Configuration stores references, not source bodies or credentials. Human/JSON summaries use workspace/source aliases and sensitivity only. If additional workspaces disagree on a scalar, retain every provenance alias, mark the conflict unresolved, and ask the user which value applies for this run.
